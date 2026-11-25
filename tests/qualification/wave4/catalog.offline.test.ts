import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadline } from './containment.js';
import { catalog,migratePristine } from './infrastructure.js';
import {readFileSync} from 'node:fs';
import {AUTH_MIGRATION_SHA256} from '../../../deploy/postgres/auth-provisioning.js';
import { hash } from './core.js';
import { offlineMigrationSource } from './migration-fixture.js';

const mocks = vi.hoisted(()=>({command:vi.fn(),source:vi.fn(),install:vi.fn(),validate:vi.fn()}));
vi.mock('../../../deploy/postgres/auth-installation.js',async()=>{
 const actual=await vi.importActual<typeof import('../../../deploy/postgres/auth-installation.js')>('../../../deploy/postgres/auth-installation.js');
 return {...actual,installCommittedAuthentication:mocks.install,validateInstalledAuthentication:mocks.validate};
});
vi.mock('../../../packages/db/src/database-role.js',()=>({assertDatabaseRole:vi.fn()}));
vi.mock('./owned-command.js',()=>({command:mocks.command}));
vi.mock('../../integration/helpers/schema-guard.js',()=>({canonicalMigrationSource:mocks.source,assertDisposableOwnedInfrastructure:vi.fn()}));
const installation={target:{database:'wave4',address:'172.18.0.2',port:5432,systemIdentifier:'1234'},dbaRole:'fixture_dba',acquireDba:async()=>{throw new Error('No runtime acquisition in injected catalog contract');}};
afterEach(()=>vi.resetAllMocks());
describe('catalog evidence injected contracts; no pg_dump or SQL execution',()=>{
  const journal=[{file:'083_lp_exact_paper_operations.sql',checksum:'a'.repeat(64),installed_checksum:'a'.repeat(64),audit_reference:null}];
  function fixture() {
    mocks.source.mockResolvedValue({files:journal.map(row=>({file:row.file,checksum:row.checksum})),digest:'b'.repeat(64)});
    mocks.command.mockResolvedValueOnce({stdout:'pg_dump (PostgreSQL) 16.4'}).mockResolvedValueOnce({stdout:'CREATE TABLE public.swat_schema_migrations (file text);'});
    const client={query:vi.fn().mockResolvedValueOnce({rows:[{catalog:{roles:[{name:'swat_app'}]}}]}).mockResolvedValueOnce({rows:journal.map(row=>({...row}))})};
    return client;
  }
  it('retains exact migration rows alongside their digest and catalog evidence',async ()=>{
    const deadline=new Deadline(1000);
    try {
      const result=await catalog(fixture(),'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4',deadline);
      expect(result.journal).toEqual(journal);expect(result.journalDigest).toBe(hash(result.journal));
      expect(result.ddl).toContain('swat_schema_migrations');expect(result.roles).toEqual({roles:[{name:'swat_app'}]});
      const args=mocks.command.mock.calls[1]!;expect(args[2]).not.toContain('synthetic');expect(args[3].PGPASSWORD).toBe('synthetic');
    } finally {deadline.dispose();}
  });
  it.each([
    ['swat%40migrator', 'synthetic%3A%40%2F%25%20%2B', 'swat@migrator', 'synthetic:@/% +'],
    ['swat%2520migrator', 'synthetic%252F', 'swat%20migrator', 'synthetic%2F'],
    ['swat+migrator', 'synthetic+value', 'swat+migrator', 'synthetic+value']
  ])('decodes credential components exactly once without placing the password in argv (%s)', async (user, pass, decodedUser, decodedPass) => {
    const deadline = new Deadline(1000);
    try {
      await catalog(fixture(), `postgresql://${user}:${pass}@127.0.0.1:15432/wave4`, deadline);
      const args = mocks.command.mock.calls[1]!;
      expect(args[2][args[2].indexOf('--username') + 1]).toBe(decodedUser);
      expect(args[3].PGPASSWORD).toBe(decodedPass);
      expect(args[2]).not.toContain(decodedPass);
    } finally { deadline.dispose(); }
  });
  it.each(['swat%ZZ:synthetic', 'swat_migrator:synthetic%ZZ'])('rejects malformed credential escapes before any command (%s)', async credentials => {
    const deadline = new Deadline(1000);
    try {
      await expect(catalog(fixture(), `postgresql://${credentials}@127.0.0.1:15432/wave4`, deadline)).rejects.toThrow(URIError);
      expect(mocks.command).not.toHaveBeenCalled();
    } finally { deadline.dispose(); }
  });
  it('checks actual installed-variant hashes and audit identity against the reviewed plan', async () => {
    const source = await offlineMigrationSource();
    const plan = source.plan!;
    const rows = plan.migrations.map(m => ({ file: m.file, checksum: m.checksum,
      installed_checksum: m.installedChecksum, audit_reference: m.auditReference }));
    fixture();
    mocks.source.mockResolvedValue(source);
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ catalog: { roles: [] } }] }).mockResolvedValueOnce({ rows }) };
    const deadline = new Deadline(1000);
    try {
      const evidence = await catalog(client, 'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4', deadline,undefined,installation);
      expect(evidence.journal).toEqual(rows);
      expect(rows.filter(r => r.installed_checksum !== r.checksum)).toHaveLength(2);
    } finally { deadline.dispose(); }
  });
  it.each(['installed_checksum', 'audit_reference'])('refuses forged reviewed-plan %s', async field => {
    const source = await offlineMigrationSource();
    const rows = source.plan!.migrations.map(m => ({ file: m.file, checksum: m.checksum,
      installed_checksum: m.installedChecksum, audit_reference: m.auditReference }));
    const index = rows.findIndex(row => row.installed_checksum !== row.checksum);
    rows[index] = { ...rows[index]!, [field]: field === 'installed_checksum' ? rows[index]!.checksum : 'unrelated-audit' };
    fixture();
    mocks.source.mockResolvedValue(source);
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ catalog: { roles: [] } }] }).mockResolvedValueOnce({ rows }) };
    const deadline = new Deadline(1000);
    try { await expect(catalog(client, 'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4', deadline,undefined,installation)).rejects.toThrow('Migration journal mismatch'); }
    finally { deadline.dispose(); }
  });
  it('087 absent capability refuses before migration/catalog effects; inert COMMIT precedes external handoff',async()=>{
    const source=await offlineMigrationSource();
    const sql=source.files.find(m=>m.file==='087_wave4_protected_authentication.sql')!.sql;
    mocks.source.mockResolvedValue(source);
    const order:string[]=[];
    const client={query:vi.fn(async(s:string)=>{order.push(s);return {
      rows:s===source.plan.handoff.validationSql?[{exact:true,namespace_oid:9000,function_oids:[9001,9002]}]:s.includes('AS dirty')?[{dirty:false}]:[],
      command:s==='BEGIN'||s==='COMMIT'?s:undefined};})};
    mocks.install.mockImplementation(async()=>{order.push('external-handoff');});
    const deadline=new Deadline(1000);
    try{
      await expect(migratePristine(client,deadline)).rejects.toThrow('capability');
      await expect(catalog(client,'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4',deadline)).rejects.toThrow('capability');
      expect(client.query).not.toHaveBeenCalled();expect(mocks.command).not.toHaveBeenCalled();
      await migratePristine(client,deadline,undefined,installation);
      expect(order.indexOf(source.plan.handoff.cleanupSql)).toBeLessThan(order.indexOf('COMMIT'));
      expect(order.indexOf('COMMIT')).toBeLessThan(order.indexOf('external-handoff'));
      expect(mocks.install).toHaveBeenCalledWith(installation,sql);
    }finally{deadline.dispose();}
  });
  it('migration uncertain COMMIT never acquires privileged handoff or publishes installation',async()=>{
    const sql=readFileSync(new URL('../../../packages/db/sql/087_wave4_protected_authentication.sql',import.meta.url),'utf8');
    mocks.source.mockResolvedValue({files:[{file:'087_wave4_protected_authentication.sql',checksum:AUTH_MIGRATION_SHA256,sql}],digest:'b'.repeat(64)});
    const client={query:vi.fn(async(s:string)=>({rows:s.includes('AS dirty')?[{dirty:false}]:[],command:s==='BEGIN'?'BEGIN':s==='COMMIT'?'ROLLBACK':undefined}))};
    const deadline=new Deadline(1000);
    try{await expect(migratePristine(client,deadline,undefined,installation)).rejects.toThrow('COMMIT uncertain');expect(mocks.install).not.toHaveBeenCalled();}
    finally{deadline.dispose();}
  });
  it('candidate catalog runs fresh disabled validation only and refuses failed validation before pg_dump',async()=>{
    const source=await offlineMigrationSource();mocks.source.mockResolvedValue(source);
    mocks.validate.mockRejectedValue(new Error('fresh disabled catalog drift'));
    const deadline=new Deadline(1000);
    try{await expect(catalog({query:vi.fn()},'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4',deadline,undefined,installation)).rejects.toThrow('fresh disabled');
      expect(mocks.validate).toHaveBeenCalledWith(installation,source.files.find(m=>m.file==='087_wave4_protected_authentication.sql')!.sql,'disabled');
      expect(mocks.install).not.toHaveBeenCalled();expect(mocks.command).not.toHaveBeenCalled();}
    finally{deadline.dispose();}
  });
  it.each(['checksum','installed_checksum','audit_reference'])('refuses mismatched journal %s before returning evidence',async field=>{
    const client=fixture();client.query.mockReset().mockResolvedValueOnce({rows:[{catalog:{roles:[]}}]}).mockResolvedValueOnce({rows:[{...journal[0],[field]:'wrong'}]});
    const deadline=new Deadline(1000);
    try {await expect(catalog(client,'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4',deadline)).rejects.toThrow('Migration journal mismatch');}
    finally {deadline.dispose();}
  });
});
