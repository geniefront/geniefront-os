import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Card, Shell } from './components/Chrome';
import { BookPage } from './pages/BookPage';
import { ManageBookingPage } from './pages/ManageBookingPage';

function MissingShop() {
  return (
    <Shell>
      <Card>
        <h1 className="text-xl font-bold">Shop not found</h1>
        <p className="mt-3 text-[var(--muted)]">Open your shop’s hosted booking link to get started.</p>
      </Card>
    </Shell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/l/:slug/g/:token" element={<ManageBookingPage />} />
        <Route path="/l/:slug" element={<ManageBookingPage />} />
        <Route path="/:slug" element={<BookPage />} />
        <Route path="*" element={<MissingShop />} />
      </Routes>
    </BrowserRouter>
  );
}
