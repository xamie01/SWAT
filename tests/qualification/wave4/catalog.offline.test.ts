import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadline } from './containment.js';
import { catalog } from './infrastructure.js';
import { hash } from './core.js';

const mocks = vi.hoisted(()=>({command:vi.fn(),source:vi.fn()}));
vi.mock('./owned-command.js',()=>({command:mocks.command}));
vi.mock('../../integration/helpers/schema-guard.js',()=>({canonicalMigrationSource:mocks.source,assertDisposableOwnedInfrastructure:vi.fn()}));
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
  it.each(['checksum','installed_checksum','audit_reference'])('refuses mismatched journal %s before returning evidence',async field=>{
    const client=fixture();client.query.mockReset().mockResolvedValueOnce({rows:[{catalog:{roles:[]}}]}).mockResolvedValueOnce({rows:[{...journal[0],[field]:'wrong'}]});
    const deadline=new Deadline(1000);
    try {await expect(catalog(client,'postgresql://swat_migrator:synthetic@127.0.0.1:15432/wave4',deadline)).rejects.toThrow('Migration journal mismatch');}
    finally {deadline.dispose();}
  });
});
