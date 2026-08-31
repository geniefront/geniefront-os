import React, { useEffect } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';

export type LegalKind = 'privacy' | 'terms' | 'sms';

const effectiveDate = 'August 16, 2026';

const legalMeta: Record<LegalKind, { title: string; description: string; eyebrow: string }> = {
  privacy: {
    title: 'Privacy Policy',
    description: 'How Jaysen Labs LLC, doing business as GenieFront, collects, uses, shares, and protects personal information.',
    eyebrow: 'Privacy & data',
  },
  terms: {
    title: 'Terms of Service',
    description: 'Terms governing GenieFront-powered guest booking websites, related features, and GenieFront shop software.',
    eyebrow: 'Service terms',
  },
  sms: {
    title: 'SMS Terms',
    description: 'Terms for transactional appointment text messages sent by or on behalf of Jaysen Labs LLC and GenieFront.',
    eyebrow: 'Messaging compliance',
  },
};

const Email = ({ type = 'privacy' }: { type?: 'privacy' | 'legal' }) => {
  const address = type === 'privacy' ? 'privacy@geniefront.com' : 'legal@geniefront.com';
  return <a className="font-bold text-[#096b61] underline decoration-[#b9d6cc] underline-offset-4" href={`mailto:${address}`}>{address}</a>;
};

const PrivacyContent = () => (
  <>
    <p>This Privacy Policy (“Policy”) explains how Jaysen Labs LLC (“we,” “us,” or “our”), doing business as GenieFront / 店小聪, collects, uses, shares, and protects personal information when you use guest booking websites and related features powered by GenieFront (the “Services”), and when shop owners (“Professionals”) use GenieFront software.</p>
    <p>When a guest books on a shop’s GenieFront-powered site, we process booking information so that shop can serve the guest. Individual shops may also publish their own privacy notices for in-store practices. For questions about a shop’s own practices, contact that shop.</p>
    <div className="legal-callout font-bold text-[#20383b]">No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Mobile opt-in data and consent will not be shared with any third parties for their marketing or promotional use.</div>

    <h2 id="privacy-who">1. Who we are</h2>
    <p>Jaysen Labs LLC operates GenieFront, online booking and front-desk software for U.S. spa, massage, foot-care, nail, and related shops. We provide software. We do not ourselves provide massage, spa, nail, or other regulated care services. Guests pay the shop in store; the guest site does not collect payment cards.</p>

    <h2 id="privacy-scope">2. Scope</h2>
    <p>This Policy applies to information submitted on GenieFront guest booking forms; appointment confirmation or reminder SMS and email you opt into; technical logs needed for security and abuse prevention; and information Professionals provide when using GenieFront admin tools.</p>
    <p>It does not cover health forms or paper records a shop collects only in store, or third-party sites unrelated to GenieFront.</p>

    <h2 id="privacy-collect">3. Information we collect</h2>
    <h3>Information you provide</h3>
    <ul>
      <li>Identifiers and contact information, including name, phone number, and email if provided.</li>
      <li>Booking details, including appointment date and time, selected services and add-ons, party size, companion details if provided, notes, and notification preferences.</li>
      <li>Professional account information, including shop name, login email, business contact details, menu, hours, and content used to run shop sites and desk tools.</li>
    </ul>
    <h3>Information collected automatically</h3>
    <ul>
      <li>Approximate device and browser type, IP address, timestamps, and page paths.</li>
      <li>Basic cookies or similar technologies needed for security, session continuity, language preference, and diagnostics.</li>
    </ul>
    <p>We do not use guest booking data to build advertising profiles or sell ads against guest phone numbers. The guest site does not collect payment card numbers or online checkout data.</p>

    <h2 id="privacy-use">4. How we use information</h2>
    <ul>
      <li>Deliver booking requests to the shop and support scheduling.</li>
      <li>Send appointment confirmations, changes, or reminders only when you opt in.</li>
      <li>Operate Professional accounts and shop websites.</li>
      <li>Secure the Services, prevent fraud and abuse, and troubleshoot.</li>
      <li>Comply with law or valid legal process.</li>
      <li>Improve the product using aggregated or de-identified information.</li>
    </ul>

    <h2 id="privacy-ai">5. Automated and AI processing</h2>
    <p>GenieFront may use automated systems, including third-party AI providers under contract, to answer or transcribe inbound shop phone calls; generate shop website layouts and copy; assist staff with scheduling, reminders, and appointment changes; and summarize public reviews or feedback a shop chooses to import.</p>
    <p>Audio, transcripts, prompts, generated pages, and summaries may be processed by subprocessors solely to provide these features. Professionals should not submit secrets or health details they do not want processed this way. AI output can be inaccurate; shops must review generated websites, bookings, and summaries before relying on them.</p>

    <h2 id="privacy-messaging">6. SMS and email consent</h2>
    <p>Appointment SMS or email is sent to the primary contact only if you check an explicit consent checkbox on the booking form. The checkbox is not pre-checked. These messages are transactional and related to your booking, not marketing or promotional blasts.</p>
    <p>Message frequency varies with your appointments, typically a confirmation and an optional 24-hour reminder per booking. Message and data rates may apply. Reply STOP to cancel SMS; reply HELP for help. See our <a href="/sms/">SMS Terms</a>.</p>

    <h2 id="privacy-share">7. How we share information</h2>
    <ul>
      <li><strong>Shops and Professionals:</strong> booking details are shared with the shop you booked so they can serve you.</li>
      <li><strong>Service providers:</strong> hosting, SMS and email delivery, AI subprocessors, and similar processors, only as needed to operate the Services and under contractual safeguards.</li>
      <li><strong>Legal and safety:</strong> when required by law or to protect rights and safety.</li>
      <li><strong>Professional advisors:</strong> legal, financial, or insurance advisors as needed to manage our business.</li>
      <li><strong>Business transfers:</strong> information may transfer in a merger, acquisition, or asset sale subject to this Policy or equivalent protections.</li>
      <li><strong>Aggregated information:</strong> data that cannot reasonably identify you.</li>
    </ul>
    <p>We do not sell personal information or guest phone numbers to third-party advertising lists. All sharing categories above exclude text messaging originator opt-in data and consent; that information will not be shared with third parties for their marketing or promotional use.</p>

    <h2 id="privacy-state">8. U.S. state privacy notice</h2>
    <p>Over the preceding 12 months we may have collected and disclosed identifiers, commercial or transaction information, internet or electronic network activity, audio or similar information when a shop uses AI phone answering, and Professional business information. We disclose these categories to the shop you booked with and to service providers that help us operate the Services. We do not sell personal information or share it for cross-context behavioral advertising as a business model.</p>

    <h2 id="privacy-cookies">9. Cookies and similar technologies</h2>
    <p>We use limited cookies or local storage for language preference, security, and basic site function. We do not operate third-party ad networks on guest booking pages. You can block cookies in your browser; some features may not work if you do.</p>

    <h2 id="privacy-choices">10. Your choices</h2>
    <ul>
      <li>SMS: reply STOP to opt out and HELP for help.</li>
      <li>Email: use unsubscribe links in non-essential emails.</li>
      <li>Privacy rights requests: email <Email />. We may need to verify your identity.</li>
      <li>Shop-only records: contact the shop directly for in-store paperwork it holds alone.</li>
    </ul>

    <h2 id="privacy-retention">11. Retention</h2>
    <p>We keep information for as long as needed to complete the visit, operate Professional accounts, resolve disputes, meet legal and accounting requirements, and then delete or de-identify it. Security logs are kept for shorter operational periods.</p>

    <h2 id="privacy-security">12. Security</h2>
    <p>We use reasonable administrative, technical, and organizational measures. No method of transmission or storage is 100% secure.</p>

    <h2 id="privacy-children">13. Children</h2>
    <p>Guest booking Services are not directed to children under 13. We do not knowingly collect personal information from children under 13. If we learn we have, we will delete it promptly. Consenting to SMS requires that you are 18 or older and the subscriber or authorized user of the phone number.</p>

    <h2 id="privacy-rights">14. Your privacy rights</h2>
    <p>Depending on where you live, you may have rights to know, access, delete, correct, and limit certain processing of personal information, and to appeal a denied request where required. California residents may also request that we not “sell” or “share” personal information. Contact <Email />. We will not discriminate against you for exercising privacy rights.</p>

    <h2 id="privacy-transfer">15. International transfers</h2>
    <p>We primarily process and store information in the United States. If you access the Services from elsewhere, you understand your information may be processed in the U.S.</p>

    <h2 id="privacy-links">16. Links to other sites</h2>
    <p>Shop sites or our pages may link to third-party websites. Their privacy practices are their own. This Policy applies only to GenieFront Services operated by Jaysen Labs LLC.</p>

    <h2 id="privacy-changes">17. Changes</h2>
    <p>We may update this Policy from time to time. We will revise the effective date on this page and, for material changes, provide additional notice in the Services where appropriate.</p>

    <h2 id="privacy-contact">18. Contact</h2>
    <p>Jaysen Labs LLC (GenieFront)<br />Privacy requests: <Email /><br />Legal: <Email type="legal" /><br />Web: <a href="https://www.geniefront.com">www.geniefront.com</a></p>
  </>
);

const TermsContent = () => (
  <>
    <p>Welcome to GenieFront. By accessing or using GenieFront-powered guest booking websites, related features, or GenieFront shop software (the “Services”), you agree to these Terms of Service (“Terms”) with Jaysen Labs LLC (“we,” “us”), doing business as GenieFront / 店小聪. If you do not agree, do not use the Services.</p>

    <h2 id="terms-services">1. Description of the Services</h2>
    <p>Jaysen Labs LLC provides software that lets shops offer online booking with pay-at-shop settlement, and tools for front-desk operations. We do not ourselves provide massage, spa, nail, or other regulated care services. Fees, taxes, and tips are charged by the shop. The guest site does not support online checkout or storing cards for consumer charges.</p>
    <h3>AI features</h3>
    <p>The Services may include AI customer service, AI-generated shop websites, AI-assisted appointment handling, and AI review summaries. These tools can make mistakes. You are responsible for reviewing outputs before publishing a site, confirming a booking, or acting on a summary. We do not provide professional, medical, or legal advice.</p>

    <h2 id="terms-shop">2. Relationship with the shop</h2>
    <p>A booking submitted on a shop’s site is a request to that shop. Fulfillment, rescheduling, cancellation, late arrival, refunds, and service standards follow that shop’s policies. GenieFront does not guarantee that a specific slot will remain available and is not responsible for the shop’s service outcomes.</p>

    <h2 id="terms-booking">3. Bookings and parties</h2>
    <p>Provide accurate contact information. For multi-guest bookings, the primary contact should inform companions of the time, services, and shop requirements. At check-in the shop may open a separate visit per guest, collect intake information, or assign technicians.</p>

    <h2 id="terms-notifications">4. SMS and email notifications</h2>
    <p>Transactional appointment SMS and email confirmations and reminders are sent only with your explicit opt-in on the booking form. Message frequency varies with your appointments. Message and data rates may apply. Reply STOP to cancel SMS; reply HELP for help. By opting in you also agree to our <a href="/sms/">SMS Terms</a> and <a href="/privacy/">Privacy Policy</a>.</p>

    <h2 id="terms-use">5. Acceptable use</h2>
    <p>You may not abuse or disrupt the Services, submit fraudulent bookings, attempt unauthorized access, or use the Services to spam or violate law. We or the shop may cancel bookings that appear abusive.</p>

    <h2 id="terms-ip">6. Intellectual property</h2>
    <p>Software, trademarks, and interfaces in the Services belong to Jaysen Labs LLC or its licensors. Shop brand names, copy, and images belong to the respective shop or its licensors.</p>

    <h2 id="terms-disclaimers">7. Disclaimers</h2>
    <p className="font-bold uppercase">To the maximum extent permitted by law, the Services are provided “as is” and “as available,” without warranties of any kind, whether express or implied, including merchantability, fitness for a particular purpose, and non-infringement. Premises safety, hygiene, technician qualifications, and care quality are the shop’s responsibility.</p>

    <h2 id="terms-liability">8. Limitation of liability</h2>
    <p className="font-bold uppercase">To the maximum extent permitted by law, Jaysen Labs LLC and its affiliates will not be liable for indirect, incidental, special, consequential, or punitive damages arising from your use of or inability to use the Services. Our total liability will not exceed the greater of US$100 or the amounts you paid us for the relevant software services in the twelve months before the claim, if any.</p>

    <h2 id="terms-indemnity">9. Indemnity</h2>
    <p>You agree to indemnify Jaysen Labs LLC and its affiliates from reasonable losses and expenses arising from third-party claims caused by your violation of these Terms, false information, or misuse of the Services, to the extent permitted by law.</p>

    <h2 id="terms-law">10. Governing law</h2>
    <p>These Terms are governed by the laws of the State of California, U.S.A., excluding conflict-of-law rules, except where mandatory consumer protection laws provide otherwise.</p>

    <h2 id="terms-changes">11. Changes</h2>
    <p>We may update these Terms and revise the effective date on this page. Continued use after an update means you accept the revised Terms.</p>

    <h2 id="terms-contact">12. Contact</h2>
    <p>Jaysen Labs LLC (GenieFront)<br /><Email type="legal" /><br /><a href="https://www.geniefront.com">www.geniefront.com</a></p>
  </>
);

const SmsContent = () => (
  <>
    <div className="legal-callout">
      <strong>Legal entity:</strong> Jaysen Labs LLC<br />
      <strong>Product:</strong> GenieFront (店小聪)<br />
      <strong>Website:</strong> <a href="https://www.geniefront.com">www.geniefront.com</a><br />
      <strong>Support:</strong> <Email /> · <Email type="legal" />
    </div>
    <p>These SMS Terms of Service (the “SMS Terms”) govern the provision, receipt, and delivery of text messages by or on behalf of Jaysen Labs LLC (“GenieFront,” “we,” “us,” or “our”) in connection with appointments booked on GenieFront-powered shop websites. By providing consent to receive texts as described below, you agree to these SMS Terms, our <a href="/terms/">Terms of Service</a>, and our <a href="/privacy/">Privacy Policy</a>.</p>

    <h2 id="sms-what">1. What GenieFront Texts are</h2>
    <p>Depending on the consent you provide on a booking form, GenieFront Texts may confirm an appointment you requested, remind you about an upcoming appointment, or notify you of a change related to an existing booking.</p>
    <p><strong>We do not</strong> use this program for advertising, promotions, coupons, or unrelated marketing campaigns. Texts are limited to Customer Care and account notifications about your booking.</p>

    <h2 id="sms-consent">2. Agreement and consent</h2>
    <p>You can provide consent by checking an explicit checkbox on a GenieFront-powered shop booking form. The checkbox is not pre-checked. Example disclosure:</p>
    <div className="legal-callout">I agree to receive a booking confirmation and a 24-hour reminder by SMS and email from GenieFront (Jaysen Labs LLC) about this appointment. Message frequency varies, typically 1–2 messages per booking. Message and data rates may apply. Reply STOP to cancel SMS; reply HELP for help.</div>
    <p>By providing consent, you authorize us to use automated or non-automated technology to send GenieFront Texts to the mobile number associated with your consent. Consent is not a condition of completing a booking request with the shop. Only the primary booking contact who opted in receives SMS.</p>

    <h2 id="sms-esign">3. E-SIGN disclosure</h2>
    <p>By providing consent to receive GenieFront Texts, you also consent to the use of an electronic record to document your agreement. To view and retain a copy, you need a device with a web browser and Internet access, and either a printer or storage space. For a free paper copy or to update contact information, email <Email /> with “SMS Terms Paper Copy” in the subject line.</p>

    <h2 id="sms-eligibility">4. Eligibility</h2>
    <p>By consenting, you represent that you are 18 years of age or older, that you are the wireless subscriber or customary user of the mobile number provided, and that you understand and agree to these SMS Terms.</p>

    <h2 id="sms-costs">5. Costs</h2>
    <p>GenieFront does not charge you a fee for GenieFront Texts, but <strong>message and data rates may apply</strong> from your wireless carrier.</p>

    <h2 id="sms-frequency">6. Frequency</h2>
    <p>Message frequency varies. Typical volume is one confirmation and optionally one reminder per appointment. You may receive additional texts if a booking is updated after you opt in. We may send a confirmation of opt-out after you text STOP.</p>

    <h2 id="sms-carriers">7. Participating carriers</h2>
    <p>GenieFront Texts are supported on major U.S. carriers. Supporting carriers may change without notice. GenieFront and mobile carriers are not liable for delayed or undelivered messages. Texts may not be compatible with all devices or plans.</p>

    <h2 id="sms-stop">8. HELP and STOP</h2>
    <ul>
      <li><strong>HELP</strong> — reply HELP to any GenieFront Text for help or support information, or email <Email />.</li>
      <li><strong>STOP</strong> — reply STOP to cancel SMS from this program. After we receive STOP, we may send one confirmation of your opt-out.</li>
    </ul>
    <p>If you use more than one number that has opted in, you must opt out separately for each number.</p>

    <h2 id="sms-samples">9. Sample messages</h2>
    <ol>
      <li>GenieFront: Your appointment at [Shop Name] is confirmed for [Day], [Date] at [Time]. Reply STOP to opt out, HELP for help. Msg&amp;data rates may apply.</li>
      <li>GenieFront reminder: Your visit at [Shop Name] is tomorrow at [Time]. Reply STOP to opt out, HELP for help.</li>
      <li>GenieFront: Your appointment at [Shop Name] was updated to [Date] [Time]. Reply STOP to opt out, HELP for help.</li>
    </ol>

    <h2 id="sms-privacy">10. Privacy and mobile information</h2>
    <div className="legal-callout font-bold text-[#20383b]">No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Mobile opt-in data and consent will not be shared with any third parties for their marketing or promotional use.</div>
    <p>Text messaging originator opt-in data and consent will not be shared with any third parties. See our full <a href="/privacy/">Privacy Policy</a>.</p>

    <h2 id="sms-changes">11. Modifications</h2>
    <p>We may modify these SMS Terms at any time by posting an updated version on this page with a revised “Last updated” date. Continued enrollment after changes are posted constitutes acceptance of the updated SMS Terms.</p>

    <h2 id="sms-contact">12. Contact</h2>
    <p>Reply HELP to any GenieFront Text, or contact <Email />, <Email type="legal" />, or visit <a href="https://www.geniefront.com">www.geniefront.com</a>.</p>
  </>
);

export const LegalPage = ({ kind }: { kind: LegalKind }) => {
  const meta = legalMeta[kind];

  useEffect(() => {
    document.documentElement.lang = 'en';
    document.title = `${meta.title} · GenieFront`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = `https://www.geniefront.com/${kind}/`;
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${meta.title} · GenieFront · Jaysen Labs LLC`);
  }, [kind, meta]);

  return (
    <div className="legal-body min-h-screen bg-[#f7f8f3]">
      <header className="border-b border-[#dfe5df] bg-[#f7f8f3]/95 backdrop-blur-xl">
        <div className="site-shell flex h-[72px] items-center justify-between">
          <a href="/" className="flex items-center gap-3 rounded-xl" aria-label="GenieFront home">
            <span className="brand-mark font-serif-brand text-xl font-semibold" aria-hidden="true">G</span>
            <span className="text-[15px] font-extrabold tracking-[-0.03em] text-[#102a2e]">GenieFront</span>
          </a>
          <nav className="hidden items-center gap-5 sm:flex" aria-label="Legal pages">
            <a href="/sms/" className={`text-xs font-bold ${kind === 'sms' ? 'text-[#096b61]' : 'text-[#53676a]'}`}>SMS Terms</a>
            <a href="/privacy/" className={`text-xs font-bold ${kind === 'privacy' ? 'text-[#096b61]' : 'text-[#53676a]'}`}>Privacy</a>
            <a href="/terms/" className={`text-xs font-bold ${kind === 'terms' ? 'text-[#096b61]' : 'text-[#53676a]'}`}>Terms</a>
          </nav>
          <a href="/" className="secondary-button h-10 min-h-0 px-3 text-xs"><ArrowLeft className="h-4 w-4" />Home</a>
        </div>
      </header>

      <main className="site-shell grid gap-12 py-14 lg:grid-cols-[230px_minmax(0,760px)] lg:justify-center lg:py-20">
        <aside className="hidden lg:block">
          <div className="sticky top-8 rounded-2xl border border-[#dfe5df] bg-white p-5">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#8a9998]">Legal center</div>
            <nav className="mt-4 space-y-1" aria-label="Legal center">
              {(['privacy', 'terms', 'sms'] as LegalKind[]).map((item) => (
                <a key={item} href={`/${item}/`} className={`block rounded-xl px-3 py-2.5 text-xs font-bold ${kind === item ? 'bg-[#edf8f3] text-[#096b61]' : 'text-[#53676a] hover:bg-[#f4f6f2]'}`}>{legalMeta[item].title}</a>
              ))}
            </nav>
            <a href="mailto:legal@geniefront.com" className="mt-5 flex items-center gap-2 border-t border-[#e4eae5] pt-4 text-[10px] font-bold text-[#096b61]">Contact legal<ExternalLink className="h-3 w-3" /></a>
          </div>
        </aside>

        <article>
          <div className="eyebrow"><span className="eyebrow-dot" />{meta.eyebrow}</div>
          <h1 className="font-serif-brand mt-6 text-5xl font-medium tracking-[-0.04em] text-[#102a2e] sm:text-6xl">{meta.title}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#647679]">{meta.description}</p>
          <div className="mt-6 inline-flex rounded-full border border-[#dfe5df] bg-white px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[#708184]">
            {kind === 'sms' ? 'Last updated' : 'Effective date'}: {effectiveDate}
          </div>
          <div className="legal-copy mt-10 border-t border-[#dfe5df] pt-7">
            {kind === 'privacy' ? <PrivacyContent /> : kind === 'terms' ? <TermsContent /> : <SmsContent />}
          </div>
        </article>
      </main>

      <footer className="border-t border-[#dfe5df] bg-white">
        <div className="site-shell flex flex-col gap-4 py-8 text-xs font-semibold text-[#708184] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Jaysen Labs LLC. GenieFront is operated by Jaysen Labs LLC.</span>
          <div className="flex gap-4"><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/sms/">SMS Terms</a></div>
        </div>
      </footer>
    </div>
  );
};
