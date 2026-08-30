import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Home } from './pages/Home';
import { Success } from './pages/Success';
import { Cancel } from './pages/Cancel';
import { Privacy, Terms } from './pages/Legal';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/signup/success" element={<Success />} />
        <Route path="/signup/cancel" element={<Cancel />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
      </Routes>
    </BrowserRouter>
  );
}
