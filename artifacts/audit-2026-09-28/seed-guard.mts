import {assertRegressionTarget} from '../../packages/db/src/qa/regressionSafety.ts';
const base={NODE_ENV:'test',DATABASE_TEST_TARGET:'isolated'};
for(const target of ['production.invalid:5432','127.0.0.1:55322','127.0.0.1:57208','127.0.0.1:57322']){
 let accepted=true;try{assertRegressionTarget({...base,DATABASE_URL:`postgres://app_user:fake@${target}/postgres`,MIGRATION_DATABASE_URL:`postgres://postgres:fake@${target}/postgres`});}catch{accepted=false;}
 console.log(JSON.stringify({target,accepted,connectionsMade:0}));
}
