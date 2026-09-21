import { defineConfig } from 'vitest/config';
// Pure renderers and mocked routes: no database credentials, seed or delivery.
export default defineConfig({test:{environment:'node',restoreMocks:true,include:[
 'src/sms/booking.test.ts','src/notify/bookingSmsDetails.test.ts','src/email/render.test.ts',
 'src/email/layout.test.ts','src/email/voiceCall.test.ts','src/email/ownerLocales.test.ts',
 'src/routes/serviceShortNames.unit.test.ts',
]}});
