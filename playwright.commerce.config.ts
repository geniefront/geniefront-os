import {defineConfig} from '@playwright/test';

// Read-only replay against the preserved local sandbox. No reset fixture or trace containing bearer URLs.
if(process.env.COMMERCE_E2E_PROFILE_PATH!=='/tmp/gf-commerce-e2e-private.json')throw new Error('Run scripts/commerce-e2e.ts through its guarded local environment');
export default defineConfig({
 testDir:'./e2e/commerce',outputDir:'artifacts/customer-commerce/p6-e2e-results',
 workers:1,fullyParallel:false,retries:0,timeout:45_000,expect:{timeout:12_000},
 reporter:[['line'],['json',{outputFile:'artifacts/customer-commerce/p6-e2e-report.json'}]],
 use:{browserName:'chromium',viewport:{width:1280,height:900},locale:'en-US',trace:'off',video:'off',screenshot:'off'},
 webServer:[
  {command:'node scripts/commerce-preview.mjs api',url:'http://127.0.0.1:3087/health',reuseExistingServer:true,timeout:120_000},
  {command:'node scripts/commerce-preview.mjs booking',url:'http://localhost:5296',reuseExistingServer:true,timeout:120_000},
  {command:'node scripts/commerce-preview.mjs desk',url:'http://localhost:5297',reuseExistingServer:true,timeout:120_000},
 ],
});
