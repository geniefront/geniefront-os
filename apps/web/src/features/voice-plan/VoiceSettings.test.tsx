import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
vi.mock('@/LanguageContext', () => ({useLanguage:()=>({t:(key:string)=>key,language:'en'})}));
vi.mock('@/lib/session',()=>({useSession:()=>({membershipId:'store'})}));
vi.mock('@/lib/permissions',()=>({useCan:()=>true}));
vi.mock('@/features/settings/api',()=>({
  useDeskSettingsQuery:()=>({data:{location:{phone:'+16676606667'},phone:{},voiceNotifications:{email:null,phone:null}}}),
  useSetupReadinessQuery:()=>({data:{aiVoice:{state:'unconfigured',ready:false,effectiveAiAnswer:false}}}),
  settingsKeys:{desk:()=>['settings']},
}));
vi.mock('@/features/setup/StepForms',()=>({StoreStepForm:()=> <p>Store form</p>,CatalogStepForm:()=> <p>Services form</p>,TeamStepForm:()=> <p>Staff and capacity form</p>}));
vi.mock('@/features/setup/steps',()=>({DirectoryStepForm:()=> <p>Directory options</p>}));
vi.mock('@/features/billing/BillingPanel',()=>({BillingPanel:()=> <p>Billing form</p>}));
import { VoiceSettings } from './VoiceSettings';
it('legacy 10DLC deep links open useful phone settings; an unprovisioned line does not block other settings', async () => {
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/settings?tab=10dlc']}><VoiceSettings /></MemoryRouter></QueryClientProvider>);
 expect(screen.getByText('voiceSummaryRecipients')).toBeVisible();
 expect(screen.queryByRole('checkbox',{name:'voiceAnswerEnabled'})).not.toBeInTheDocument();
 expect(screen.getAllByText('voiceRouteManaged').length).toBeGreaterThan(0);
 expect(screen.queryByText(/10DLC|DNS|营销|收银/)).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'voiceTeamTab'}));
 await waitFor(()=>expect(screen.getByText('Staff and capacity form')).toBeVisible());
});
