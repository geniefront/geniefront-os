import {loadEnv} from '/Users/naiyouzhu/siteadmin/geniefront-os/vitest.shared.ts';
process.env.GF_TEST_NO_DOTENV='1';
process.env.DATABASE_TEST_TARGET='isolated';
process.env.TEST_DATABASE_URL='postgresql://app_user:dummy@production.invalid:5432/postgres';
process.env.TEST_MIGRATION_DATABASE_URL='postgresql://postgres:dummy@production.invalid:5432/postgres';
const result=loadEnv({database:true});
console.log(JSON.stringify({acceptedNonLocalTestDatabase:result.DATABASE_URL?.includes('production.invalid'),connectionsMade:0}));
