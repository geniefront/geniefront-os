import { useState } from 'react';
import { AiCopilotShowcase } from '../components/AiCopilotShowcase';
import { CtaSection } from '../components/CtaSection';
import { DailyWorkflowTimeline } from '../components/DailyWorkflowTimeline';
import { FaqSection } from '../components/FaqSection';
import { Footer } from '../components/Footer';
import { Hero } from '../components/Hero';
import { IndustryGrid } from '../components/IndustryGrid';
import { MenuScannerModal } from '../components/MenuScannerModal';
import { Navbar } from '../components/Navbar';
import { PainPointsComparison } from '../components/PainPointsComparison';
import { PricingSection } from '../components/PricingSection';
import { RotationWorkflowSection } from '../components/RotationWorkflowSection';
import { SecurityAndTrust } from '../components/SecurityAndTrust';
import { SinglePcFrontDeskSection } from '../components/SinglePcFrontDeskSection';
import { StaffPwaAndKioskSection } from '../components/StaffPwaAndKioskSection';
import { TrialModal } from '../components/TrialModal';
import { LanguageProvider } from '../context/LanguageContext';

function LandingPage() {
  const [isMenuScannerOpen, setIsMenuScannerOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#f7f8f3] text-[#102a2e] font-sans antialiased">
      <Navbar />
      <main>
        <Hero />
        <IndustryGrid />
        <PainPointsComparison />
        <RotationWorkflowSection />
        <SinglePcFrontDeskSection />
        <AiCopilotShowcase onOpenMenuScanner={() => setIsMenuScannerOpen(true)} />
        <StaffPwaAndKioskSection />
        <DailyWorkflowTimeline />
        <SecurityAndTrust />
        <PricingSection />
        <FaqSection />
        <CtaSection />
      </main>
      <Footer />
      <TrialModal />
      <MenuScannerModal
        isOpen={isMenuScannerOpen}
        onClose={() => setIsMenuScannerOpen(false)}
      />
    </div>
  );
}

export function Home() {
  return (
    <LanguageProvider>
      <LandingPage />
    </LanguageProvider>
  );
}
