import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['src/queries/bookingStaff.unit.test.ts','src/staffProtection.unit.test.ts','src/staffTimeOff.unit.test.ts'],restoreMocks:true}});
