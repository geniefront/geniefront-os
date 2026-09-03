import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Card, Shell } from './components/Chrome';
import { BookPage } from './pages/BookPage';
import { ManageBookingPage } from './pages/ManageBookingPage';
import { LanguageProvider, useLanguage } from './lib/i18n';

function MissingShop() {
  const { t } = useLanguage();
  return (
    <Shell>
      <Card>
        <h1 className="text-xl font-bold">{t('status.notFound')}</h1>
        <p className="mt-3 text-[var(--muted)]">{t('shop.notFoundDesc')}</p>
      </Card>
    </Shell>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/l/:slug/g/:token" element={<ManageBookingPage />} />
          <Route path="/l/:slug" element={<ManageBookingPage />} />
          <Route path="/:slug" element={<BookPage />} />
          <Route path="*" element={<MissingShop />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}
