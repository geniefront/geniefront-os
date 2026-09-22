import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import { Card, Shell } from './components/Chrome';
import { BookingExperiencePage } from './pages/BookingExperiencePage';
import { BookPage } from './pages/BookPage';
import { ManageBookingPage } from './pages/ManageBookingPage';
import { LanguageProvider, useLanguage } from './lib/i18n';

const AppointmentPreview = import.meta.env.DEV ? lazy(() => import('./dev/AppointmentPreview')) : null;

function MissingShop() {
  const { t } = useLanguage();
  return (
    <Shell>
      <Card className="mx-auto mt-16 max-w-lg md:mt-24">
        <h1 className="text-xl font-bold tracking-tight">{t('status.notFound')}</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{t('shop.notFoundDesc')}</p>
      </Card>
    </Shell>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          {AppointmentPreview && <Route path="/__preview/appointment" element={<Suspense fallback={null}><AppointmentPreview /></Suspense>} />}
          <Route path="/l/:slug/g/:token" element={<ManageBookingPage />} />
          <Route path="/l/:slug" element={<ManageBookingPage />} />
          <Route path="/:slug/bundles" element={<BookPage />} />
          <Route path="/:slug" element={<ExperienceRoute />} />
          <Route path="*" element={<MissingShop />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}

function ExperienceRoute() { const {slug}=useParams(); return <BookingExperiencePage key={slug}/>; }
