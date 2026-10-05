// node --env-file=.env.local --env-file=.env.commerce-ci scripts/commerce-preview.mjs api|desk|booking
import {spawn} from 'node:child_process';
const target=process.argv[2];
if(process.env.DATABASE_TEST_TARGET!=='isolated'||new URL(process.env.TEST_DATABASE_URL??'').port!=='58332')throw new Error('Commerce preview requires the dedicated QA container');
const env={...process.env,GF_CUSTOMER_COMMERCE_ENABLED:'1',COMMERCE_STRIPE_MODE:'test',COMMUNICATION_DELIVERY_MODE:'capture',
  VITE_API_BASE:'http://localhost:3087',BOOKING_BASE_URL:'http://localhost:5296',BOOKING_PAGE_ORIGIN:'http://localhost:5296',APP_BASE_URL:'http://localhost:5297',LOG_LEVEL:'warn'};
const args=target==='api'?['--import','tsx','scripts/commerce-local-server.ts']:
  ['--filter',target==='desk'?'@gf/web':'@gf/booking','exec','vite','--host','127.0.0.1','--port',target==='desk'?'5297':'5296'];
if(!['api','desk','booking'].includes(target))throw new Error('Expected api|desk|booking');
const child=spawn(target==='api'?process.execPath:'pnpm',args,{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));
