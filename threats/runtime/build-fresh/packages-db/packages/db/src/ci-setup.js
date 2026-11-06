import pg from 'pg';
const { Client } = pg;
const url = process.env.ADMIN_DATABASE_URL ||
    'postgresql://postgres:swat@postgres:5432/swat_integration';
async function setup() {
    let attempts = 30;
    while (attempts > 0) {
        let client = null;
        try {
            client = new Client({ connectionString: url });
            await client.connect();
            console.log('Connected to PostgreSQL as superuser (postgres).');
            await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swat') THEN
            CREATE ROLE swat WITH LOGIN PASSWORD 'swat' CREATEDB CREATEROLE;
          ELSE
            ALTER ROLE swat CREATEDB CREATEROLE;
          END IF;
          ALTER DATABASE swat_integration OWNER TO swat;
          GRANT ALL PRIVILEGES ON DATABASE swat_integration TO swat;
        END $$;
      `);
            await client.end();
            console.log('Successfully initialized non-superuser swat role and database ownership.');
            return;
        }
        catch (err) {
            if (client) {
                try {
                    await client.end();
                }
                catch { }
            }
            attempts--;
            if (attempts === 0) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.log(`Waiting for PostgreSQL... (${message})`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}
setup().catch((err) => {
    console.error('Failed to initialize CI database:', err);
    process.exit(1);
});
//# sourceMappingURL=ci-setup.js.map