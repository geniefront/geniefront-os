import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { LegalPage } from './components/LegalPage';
import { Cancel } from './pages/Cancel';
import { Home } from './pages/Home';
import { Success } from './pages/Success';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/signup/success" element={<Success />} />
        <Route path="/signup/cancel" element={<Cancel />} />
        <Route path="/terms/*" element={<LegalPage kind="terms" />} />
        <Route path="/privacy/*" element={<LegalPage kind="privacy" />} />
        <Route path="/sms/*" element={<LegalPage kind="sms" />} />
      </Routes>
    </BrowserRouter>
  );
}
