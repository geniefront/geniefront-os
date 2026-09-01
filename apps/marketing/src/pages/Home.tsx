import { useEffect, useState } from 'react';
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
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';

function LandingPage() {
  const { currentLang } = useLanguage();
  const ui = uiText[currentLang];
  const [isMenuScannerOpen, setIsMenuScannerOpen] = useState(false);

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('main > section'));
    sections.forEach((section, index) => {
      section.classList.add('reveal-section');
      section.style.setProperty('--reveal-order', String(index));
    });

    if (!('IntersectionObserver' in window)) {
      sections.forEach((section) => section.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-[#f7f8f3] text-[#102a2e] font-sans antialiased">
      <a className="skip-link" href="#main-content">{ui.skipToContent}</a>
      <Navbar />
      <main id="main-content">
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
