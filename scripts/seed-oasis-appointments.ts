import postgres from 'postgres/cjs/src/index.js';
import { randomUUID } from 'node:crypto';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not defined');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const ORG_ID = '22f4ea3b-ad55-4b19-8b0b-a6f1ec5f29e4';
const LOC_ID = '34662479-0f85-4754-8f1d-36b61d2fa942';
const CREATED_BY = 'cee386c4-3176-482e-a6cb-38fb8234e4ee';

// Technicians
const STAFF = {
  amy1: '54270d07-2a9b-4936-b465-160038b1afa1',
  amy2: '73cbe399-b40b-473d-80d8-71f36f312173',
  amy3: '58667c73-c63e-42a7-a995-7a40f78a28be',
  amy4: '885de528-92a3-4415-9ec1-45409aeb3285',
  amy5: '7da6d9ca-0579-470e-9941-c5cb2355f029',
  amy6: '254dc770-e5dd-47a0-8d8d-8ac013f88f73',
  amy8: 'bc7ef682-971f-4d2c-b058-fd716dd2ea20',
};

// Resources
const RES = {
  room1: '28bb30df-5cc4-425e-8772-b9b7316778a4', // capacity 1
  couples: '8298a2d2-a336-4d1c-a423-f0c0be07809a', // capacity 2
};

// Services
const SERVICES = {
  dt60: { id: '668bc84f-4a9f-437d-8a16-dba1b377edc0', name: 'Deep Tissue Massage · 60 mins', min: 60, cents: 9900 },
  dt90: { id: '31b51ae9-6b38-43ab-84c8-c4f773c33511', name: 'Deep Tissue Massage · 90 mins', min: 90, cents: 15900 },
  relax60: { id: '8e1f4094-c819-4119-bf4a-669f7e9d1874', name: 'Relaxation Massage · 60 mins', min: 60, cents: 7900 },
  relax90: { id: '81de7690-625b-4583-80ee-2c76a1d4b7aa', name: 'Relaxation Massage · 90 mins', min: 90, cents: 13900 },
  combo60: { id: '79dd65ac-a170-423f-963d-7f6e9b6418fc', name: 'Combination Massage · 60 mins', min: 60, cents: 8900 },
  combo90: { id: '7d0f1935-49af-439b-a1bc-b089619879f9', name: 'Combination Massage · 90 mins', min: 90, cents: 14900 },
  prenatal60: { id: '704aee4a-7c3e-492c-ac87-018c8460e05f', name: 'Prenatal Massage · 60 mins', min: 60, cents: 11900 },
  lymph60: { id: 'f75dd1e2-5ffc-46a8-8cd8-a4da670b9d25', name: 'Lymphatic Drainage Massage · 60 mins', min: 60, cents: 11900 },
  myo60: { id: '8b1e6d16-273b-44cf-8302-b5f5bcac4073', name: 'Myofascial Release Massage · 60 mins', min: 60, cents: 11900 },
  tmj60: { id: 'fb3a8e95-2610-4f22-a27c-5bc0c96d5d25', name: 'TMJ & Frozen Shoulder Treatment · 60 mins', min: 60, cents: 11900 },
  couples60: { id: '377cd285-83ba-492c-8312-f7ccc8a18934', name: 'Couples Massage · 60 mins', min: 60, cents: 17900 },
  aha30: { id: 'a77f62ae-021a-4c82-99f5-36c96e473258', name: 'AHA Glow Facial · 30 mins', min: 30, cents: 7900 },
  aha60: { id: 'a2daac0c-8afd-4ab4-b7a7-30873c605568', name: 'AHA Glow Facial · 60 mins', min: 60, cents: 10900 },
  vitC60: { id: 'e3ae3de9-8ac1-4727-9d66-4f0204192f95', name: 'Vitamin C Brightening Facial · 60 mins', min: 60, cents: 12900 },
  manFacial50: { id: '0d1ca0b4-ba20-4a56-a8d1-74aecb617702', name: 'Man’s Facial · 50 mins', min: 50, cents: 9900 },
  oxygen70: { id: '36038c11-f465-4263-a1e4-cd4612c1ce98', name: 'Oxygen Lifting Facial · 70 mins', min: 70, cents: 17900 },
  execFacial80: { id: '727f50a4-43c6-4163-8436-c0202a1364f5', name: 'Gentleman’s Executive Facial · 80 mins', min: 80, cents: 16900 },
  lymphFacial70: { id: '09aa3975-5a6d-4c7d-b3d5-94539c63d08d', name: 'Lymphatic Drainage Facial · 70 mins', min: 70, cents: 14900 },
};

// Addons
const ADDONS = {
  hotStone: 'af121751-d676-455b-a92f-174eaea44271',
  aromaOil: 'dc898fc7-7a7f-4969-b155-1de076e53493',
  cupping: 'a6330219-d57f-40da-a247-3218e65944c8',
  guasha: '871c31ec-bdb4-443a-a853-33c983a80c7e',
  ledLight: '60fe23f2-b88b-4c07-8f11-eb55dffe98e8',
};

// Realistic customers list (NANP test numbers: +15550100 - +15550199)
const CUSTOMER_DEFS = [
  { name: 'Emily Watson', first: 'Emily', last: 'Watson', phone: '+15550101', email: 'emily.w@example.com', gender: 'female', tags: ['vip', 'regular'], notes: 'Prefers medium pressure. Allergic to citrus scents.' },
  { name: 'Marcus Vance', first: 'Marcus', last: 'Vance', phone: '+15550102', email: 'marcus.v@example.com', gender: 'male', tags: ['regular'], notes: 'Heavy gym goer, focus on upper traps & lats.' },
  { name: 'Sophia Ramirez', first: 'Sophia', last: 'Ramirez', phone: '+15550103', email: 'sophia.r@example.com', gender: 'female', tags: ['prenatal'], notes: '26 weeks pregnant, side-lying position with bolsters.' },
  { name: 'David Miller', first: 'David', last: 'Miller', phone: '+15550104', email: 'david.m@example.com', gender: 'male', tags: ['first_time'], notes: 'Desk worker, stiffness in neck and shoulders.' },
  { name: 'Jessica Chen', first: 'Jessica', last: 'Chen', phone: '+15550105', email: 'jessica.c@example.com', gender: 'female', tags: ['vip', 'skincare'], notes: 'Loves Vitamin C and LED therapy. Sensitive facial skin.' },
  { name: 'Brian O’Connor', first: 'Brian', last: 'O’Connor', phone: '+15550106', email: 'brian.oc@example.com', gender: 'male', tags: ['therapeutic'], notes: 'Frozen shoulder rehabilitation, gentle range of motion.' },
  { name: 'Chloe Bennett', first: 'Chloe', last: 'Bennett', phone: '+15550107', email: 'chloe.b@example.com', gender: 'female', tags: ['regular'], notes: 'Prefers lavender aroma oil, gentle soothing music.' },
  { name: 'Daniel Kim', first: 'Daniel', last: 'Kim', phone: '+15550108', email: 'daniel.k@example.com', gender: 'male', tags: ['regular'], notes: 'Firm pressure requested, focus on lower back.' },
  { name: 'Olivia Smith', first: 'Olivia', last: 'Smith', phone: '+15550109', email: 'olivia.s@example.com', gender: 'female', tags: ['skincare'], notes: 'Lymphatic drainage lover, drinks plenty of water.' },
  { name: 'James Wilson', first: 'James', last: 'Wilson', phone: '+15550110', email: 'james.w@example.com', gender: 'male', tags: ['regular'], notes: 'Prefers Amy1, combination massage.' },
  { name: 'Amanda White', first: 'Amanda', last: 'White', phone: '+15550111', email: 'amanda.w@example.com', gender: 'female', tags: ['skincare'], notes: 'AHA glow facial monthly routine.' },
  { name: 'Robert Taylor', first: 'Robert', last: 'Taylor', phone: '+15550112', email: 'robert.t@example.com', gender: 'male', tags: ['massage_lover'], notes: 'Hot stone enthusiast, full body relaxation.' },
  { name: 'Hannah Brooks', first: 'Hannah', last: 'Brooks', phone: '+15550113', email: 'hannah.b@example.com', gender: 'female', tags: ['regular'], notes: 'Oxygen lifting facial, bride-to-be preparation.' },
  { name: 'Tyler Johnson', first: 'Tyler', last: 'Johnson', phone: '+15550114', email: 'tyler.j@example.com', gender: 'male', tags: ['first_time'], notes: 'Runner with tight calves and hamstrings.' },
  { name: 'Rachel Adams', first: 'Rachel', last: 'Adams', phone: '+15550115', email: 'rachel.a@example.com', gender: 'female', tags: ['vip'], notes: 'Gold VIP, requests Amy2 or Amy3.' },
  { name: 'Ethan Martinez', first: 'Ethan', last: 'Martinez', phone: '+15550116', email: 'ethan.m@example.com', gender: 'male', tags: ['regular'], notes: 'Relaxation massage after long travel.' },
  { name: 'Grace Kelly', first: 'Grace', last: 'Kelly', phone: '+15550117', email: 'grace.k@example.com', gender: 'female', tags: ['skincare'], notes: 'Executive facial package, very punctual.' },
  { name: 'Lucas Wright', first: 'Lucas', last: 'Wright', phone: '+15550118', email: 'lucas.w@example.com', gender: 'male', tags: ['therapeutic'], notes: 'Myofascial release for IT band and lower back.' },
  { name: 'Victoria Hall', first: 'Victoria', last: 'Hall', phone: '+15550119', email: 'victoria.h@example.com', gender: 'female', tags: ['prenatal'], notes: 'Prenatal 60 min, gentle foot reflexology.' },
  { name: 'Benjamin Scott', first: 'Benjamin', last: 'Scott', phone: '+15550120', email: 'benjamin.s@example.com', gender: 'male', tags: ['regular'], notes: 'Deep tissue firm pressure, neck focus.' },
  { name: 'Natalie Green', first: 'Natalie', last: 'Green', phone: '+15550121', email: 'natalie.g@example.com', gender: 'female', tags: ['regular'], notes: 'Cupping therapy for upper back tension.' },
  { name: 'Alexander Wood', first: 'Alexander', last: 'Wood', phone: '+15550122', email: 'alexander.w@example.com', gender: 'male', tags: ['therapeutic'], notes: 'TMJ and jaw tension release from teeth grinding.' },
  { name: 'Samantha King', first: 'Samantha', last: 'King', phone: '+15550123', email: 'samantha.k@example.com', gender: 'female', tags: ['massage_lover'], notes: 'Aroma oil + hot stone combination.' },
  { name: 'Kevin Patel', first: 'Kevin', last: 'Patel', phone: '+15550124', email: 'kevin.p@example.com', gender: 'male', tags: ['regular'], notes: 'Weekly combination massage regular.' },
  { name: 'Ashley Turner', first: 'Ashley', last: 'Turner', phone: '+15550125', email: 'ashley.t@example.com', gender: 'female', tags: ['express'], notes: 'Express lunch-break AHA facial.' },
  { name: 'Justin Phillips', first: 'Justin', last: 'Phillips', phone: '+15550126', email: 'justin.p@example.com', gender: 'male', tags: ['skincare'], notes: 'Man facial with beard conditioning.' },
  { name: 'Megan Campbell', first: 'Megan', last: 'Campbell', phone: '+15550127', email: 'megan.c@example.com', gender: 'female', tags: ['vip'], notes: 'VIP facial client, prefers organic serums.' },
  { name: 'Brandon Evans', first: 'Brandon', last: 'Evans', phone: '+15550128', email: 'brandon.e@example.com', gender: 'male', tags: ['regular'], notes: 'Deep tissue 90 mins, prefers Amy8.' },
  { name: 'Lauren Edwards', first: 'Lauren', last: 'Edwards', phone: '+15550129', email: 'lauren.e@example.com', gender: 'female', tags: ['skincare'], notes: 'Post-flight lymphatic drainage facial.' },
  { name: 'Eric Collins', first: 'Eric', last: 'Collins', phone: '+15550130', email: 'eric.c@example.com', gender: 'male', tags: ['regular'], notes: 'Weekend relaxation massage.' },
  { name: 'Stephanie Stewart', first: 'Stephanie', last: 'Stewart', phone: '+15550131', email: 'stephanie.s@example.com', gender: 'female', tags: ['regular'], notes: 'Prefers deep firm pressure on shoulder blades.' },
  { name: 'Andrew Morris', first: 'Andrew', last: 'Morris', phone: '+15550132', email: 'andrew.m@example.com', gender: 'male', tags: ['first_time'], notes: 'First visit, referred by Emily Watson.' },
  { name: 'Nicole Rogers', first: 'Nicole', last: 'Rogers', phone: '+15550133', email: 'nicole.r@example.com', gender: 'female', tags: ['vip'], notes: 'Birthday spa day celebration.' },
  { name: 'Christopher Reed', first: 'Christopher', last: 'Reed', phone: '+15550134', email: 'christopher.r@example.com', gender: 'male', tags: ['therapeutic'], notes: 'Lower back stiffness and sciatica discomfort.' },
  { name: 'Katherine Cook', first: 'Katherine', last: 'Cook', phone: '+15550135', email: 'katherine.c@example.com', gender: 'female', tags: ['skincare'], notes: 'Oxygen lifting facial, gentle extraction.' },
];

interface DailySlot {
  time: string;
  serviceKey: keyof typeof SERVICES;
  staffKey: keyof typeof STAFF;
  resourceKey: keyof typeof RES | null;
  customerIndex: number | null;
  walkInName?: string;
  isRequest?: boolean;
  addons?: (keyof typeof ADDONS)[];
  notes?: string;
  source?: 'desk' | 'web' | 'phone_ai';
}

const DAY_TEMPLATES: DailySlot[][] = [
  // Day 1 (Saturday 2026-09-19)
  [
    { time: '10:00', serviceKey: 'dt60', staffKey: 'amy1', resourceKey: 'room1', customerIndex: 0, isRequest: true, notes: 'Focus on lower back & shoulders', addons: ['hotStone'], source: 'desk' },
    { time: '10:30', serviceKey: 'aha60', staffKey: 'amy2', resourceKey: null, customerIndex: 4, notes: 'Gentle facial, sensitive skin', addons: ['ledLight'], source: 'web' },
    { time: '11:00', serviceKey: 'relax60', staffKey: 'amy3', resourceKey: null, customerIndex: 1, notes: 'Upper back relaxation after workout', source: 'desk' },
    { time: '11:30', serviceKey: 'manFacial50', staffKey: 'amy4', resourceKey: null, customerIndex: 3, notes: 'First time facial, beard trim consultation', source: 'phone_ai' },
    { time: '13:00', serviceKey: 'dt90', staffKey: 'amy5', resourceKey: 'room1', customerIndex: 7, isRequest: true, notes: 'Prefers firm pressure, deep tissue 90min', source: 'desk' },
    { time: '14:00', serviceKey: 'prenatal60', staffKey: 'amy1', resourceKey: null, customerIndex: 2, notes: 'Prenatal massage, side-lying position', source: 'web' },
    { time: '15:00', serviceKey: 'combo60', staffKey: 'amy6', resourceKey: null, customerIndex: null, walkInName: '散客 (Mark)', notes: 'Walk-in guest, full body combo', source: 'desk' },
    { time: '16:00', serviceKey: 'couples60', staffKey: 'amy2', resourceKey: 'couples', customerIndex: 12, notes: 'Couples massage room booking part 1', addons: ['aromaOil'], source: 'desk' },
    { time: '17:30', serviceKey: 'vitC60', staffKey: 'amy8', resourceKey: null, customerIndex: 10, isRequest: true, notes: 'Vitamin C Brightening Facial with serum boost', source: 'web' },
    { time: '19:00', serviceKey: 'tmj60', staffKey: 'amy3', resourceKey: 'room1', customerIndex: 5, notes: 'TMJ jaw and shoulder tension treatment', source: 'phone_ai' },
  ],
  // Day 2 (Sunday 2026-09-20)
  [
    { time: '10:00', serviceKey: 'relax90', staffKey: 'amy3', resourceKey: null, customerIndex: 6, notes: 'Lavender aroma oil, peaceful session', addons: ['aromaOil'], source: 'web' },
    { time: '10:30', serviceKey: 'dt60', staffKey: 'amy4', resourceKey: 'room1', customerIndex: 11, notes: 'Hot stone back therapy', addons: ['hotStone'], source: 'desk' },
    { time: '11:30', serviceKey: 'lymph60', staffKey: 'amy1', resourceKey: null, customerIndex: 8, isRequest: true, notes: 'Lymphatic drainage for leg swelling', source: 'desk' },
    { time: '13:00', serviceKey: 'combo90', staffKey: 'amy2', resourceKey: null, customerIndex: 9, notes: 'Combination massage, firm on shoulders', source: 'phone_ai' },
    { time: '14:00', serviceKey: 'oxygen70', staffKey: 'amy5', resourceKey: null, customerIndex: 14, notes: 'Pre-event oxygen facial', source: 'web' },
    { time: '15:00', serviceKey: 'myo60', staffKey: 'amy6', resourceKey: 'room1', customerIndex: 17, notes: 'Myofascial release for IT band', source: 'desk' },
    { time: '16:30', serviceKey: 'aha30', staffKey: 'amy8', resourceKey: null, customerIndex: 24, notes: 'Quick glow refresh', source: 'web' },
    { time: '17:00', serviceKey: 'dt60', staffKey: 'amy1', resourceKey: null, customerIndex: 13, notes: 'Stiff neck from running', source: 'desk' },
    { time: '18:00', serviceKey: 'relax60', staffKey: 'amy4', resourceKey: 'room1', customerIndex: 15, notes: 'Post-travel relaxation', source: 'desk' },
    { time: '19:00', serviceKey: 'execFacial80', staffKey: 'amy2', resourceKey: null, customerIndex: 16, isRequest: true, notes: 'Executive facial with warm towel wrap', source: 'phone_ai' },
  ],
  // Day 3 (Monday 2026-09-21)
  [
    { time: '10:00', serviceKey: 'prenatal60', staffKey: 'amy2', resourceKey: null, customerIndex: 18, notes: 'Prenatal gentle relief', source: 'web' },
    { time: '10:30', serviceKey: 'dt60', staffKey: 'amy5', resourceKey: 'room1', customerIndex: 19, notes: 'Lower back stiffness relief', source: 'desk' },
    { time: '11:30', serviceKey: 'aha60', staffKey: 'amy1', resourceKey: null, customerIndex: 26, isRequest: true, notes: 'Organic AHA peel treatment', addons: ['ledLight'], source: 'web' },
    { time: '13:00', serviceKey: 'combo60', staffKey: 'amy3', resourceKey: null, customerIndex: 23, notes: 'Monday reset massage', source: 'desk' },
    { time: '14:00', serviceKey: 'tmj60', staffKey: 'amy4', resourceKey: null, customerIndex: 21, notes: 'Jaw tension and neck stiffness', source: 'phone_ai' },
    { time: '15:30', serviceKey: 'dt90', staffKey: 'amy8', resourceKey: 'room1', customerIndex: 27, isRequest: true, notes: 'Deep tissue 90min, requested Amy8 specifically', source: 'desk' },
    { time: '16:00', serviceKey: 'relax60', staffKey: 'amy6', resourceKey: null, customerIndex: null, walkInName: '散客 (David S.)', notes: 'Walk-in after gym', source: 'desk' },
    { time: '17:30', serviceKey: 'lymphFacial70', staffKey: 'amy1', resourceKey: null, customerIndex: 28, notes: 'Facial lymph drainage and cooling mask', source: 'web' },
    { time: '18:30', serviceKey: 'relax90', staffKey: 'amy5', resourceKey: null, customerIndex: 29, notes: 'Full 90 min unwinding session', addons: ['aromaOil'], source: 'desk' },
    { time: '19:30', serviceKey: 'aha30', staffKey: 'amy2', resourceKey: null, customerIndex: 4, notes: 'Maintenance quick glow', source: 'web' },
  ],
  // Day 4 (Tuesday 2026-09-22)
  [
    { time: '10:00', serviceKey: 'dt60', staffKey: 'amy1', resourceKey: 'room1', customerIndex: 30, isRequest: true, notes: 'Shoulder blades deep release', addons: ['cupping'], source: 'desk' },
    { time: '11:00', serviceKey: 'manFacial50', staffKey: 'amy3', resourceKey: null, customerIndex: 25, notes: 'Men skincare consultation', source: 'web' },
    { time: '11:30', serviceKey: 'relax60', staffKey: 'amy6', resourceKey: null, customerIndex: 31, notes: 'First visit, requested medium pressure', source: 'phone_ai' },
    { time: '13:00', serviceKey: 'combo90', staffKey: 'amy4', resourceKey: null, customerIndex: 1, notes: '90 min combo with stretching', source: 'desk' },
    { time: '14:30', serviceKey: 'oxygen70', staffKey: 'amy2', resourceKey: null, customerIndex: 34, notes: 'Hydrating oxygen facial', addons: ['ledLight'], source: 'web' },
    { time: '15:00', serviceKey: 'dt90', staffKey: 'amy5', resourceKey: 'room1', customerIndex: 0, isRequest: true, notes: 'Emily Watson bi-weekly regular visit', source: 'desk' },
    { time: '16:30', serviceKey: 'tmj60', staffKey: 'amy8', resourceKey: null, customerIndex: 33, notes: 'Sciatica and lower back therapy', source: 'phone_ai' },
    { time: '17:30', serviceKey: 'vitC60', staffKey: 'amy1', resourceKey: null, customerIndex: 32, notes: 'Birthday facial glow', source: 'web' },
    { time: '18:30', serviceKey: 'relax60', staffKey: 'amy3', resourceKey: null, customerIndex: null, walkInName: '散客 (Linda)', notes: 'Evening walk-in, relaxation', source: 'desk' },
    { time: '19:00', serviceKey: 'dt60', staffKey: 'amy6', resourceKey: 'room1', customerIndex: 7, notes: 'Deep tissue maintenance', source: 'desk' },
  ],
  // Day 5 (Wednesday 2026-09-23)
  [
    { time: '10:00', serviceKey: 'lymph60', staffKey: 'amy4', resourceKey: null, customerIndex: 8, notes: 'Midweek detox lymphatic massage', source: 'web' },
    { time: '10:30', serviceKey: 'aha60', staffKey: 'amy8', resourceKey: null, customerIndex: 10, isRequest: true, notes: 'AHA facial + LED Light add-on', addons: ['ledLight'], source: 'desk' },
    { time: '11:30', serviceKey: 'dt60', staffKey: 'amy2', resourceKey: 'room1', customerIndex: 11, notes: 'Hot stone back treatment', addons: ['hotStone'], source: 'desk' },
    { time: '13:00', serviceKey: 'prenatal60', staffKey: 'amy1', resourceKey: null, customerIndex: 2, isRequest: true, notes: 'Prenatal massage with pregnancy pillows', source: 'web' },
    { time: '14:00', serviceKey: 'relax90', staffKey: 'amy5', resourceKey: null, customerIndex: 6, notes: 'Soothing Swedish relaxation 90 mins', addons: ['aromaOil'], source: 'phone_ai' },
    { time: '15:30', serviceKey: 'myo60', staffKey: 'amy3', resourceKey: 'room1', customerIndex: 17, notes: 'Targeted myofascial work', source: 'desk' },
    { time: '16:30', serviceKey: 'manFacial50', staffKey: 'amy6', resourceKey: null, customerIndex: 3, notes: 'Gentle facial cleanse', source: 'web' },
    { time: '17:30', serviceKey: 'combo60', staffKey: 'amy8', resourceKey: null, customerIndex: 9, notes: 'Combo massage, focus on neck', source: 'desk' },
    { time: '18:30', serviceKey: 'dt90', staffKey: 'amy4', resourceKey: null, customerIndex: 27, isRequest: true, notes: 'Firm pressure deep tissue', source: 'phone_ai' },
    { time: '19:30', serviceKey: 'aha30', staffKey: 'amy1', resourceKey: null, customerIndex: 24, notes: 'Express AHA Glow', source: 'web' },
  ],
  // Day 6 (Thursday 2026-09-24)
  [
    { time: '10:00', serviceKey: 'dt60', staffKey: 'amy5', resourceKey: 'room1', customerIndex: 13, notes: 'Morning tension release', source: 'desk' },
    { time: '10:30', serviceKey: 'vitC60', staffKey: 'amy1', resourceKey: null, customerIndex: 4, isRequest: true, notes: 'Vitamin C Brightening Facial', addons: ['ledLight'], source: 'web' },
    { time: '11:30', serviceKey: 'relax60', staffKey: 'amy2', resourceKey: null, customerIndex: 15, notes: 'Relaxation massage', addons: ['aromaOil'], source: 'desk' },
    { time: '13:00', serviceKey: 'execFacial80', staffKey: 'amy3', resourceKey: null, customerIndex: 16, notes: 'Gentleman executive facial package', source: 'phone_ai' },
    { time: '14:30', serviceKey: 'combo90', staffKey: 'amy6', resourceKey: null, customerIndex: 23, notes: 'Combo massage 90 mins', source: 'desk' },
    { time: '15:00', serviceKey: 'tmj60', staffKey: 'amy1', resourceKey: 'room1', customerIndex: 5, isRequest: true, notes: 'Brian TMJ routine therapy', source: 'desk' },
    { time: '16:30', serviceKey: 'lymphFacial70', staffKey: 'amy8', resourceKey: null, customerIndex: 12, notes: 'Lymphatic drainage facial', source: 'web' },
    { time: '17:30', serviceKey: 'dt90', staffKey: 'amy2', resourceKey: null, customerIndex: 7, notes: 'Deep tissue 90min session', source: 'phone_ai' },
    { time: '18:30', serviceKey: 'relax60', staffKey: 'amy4', resourceKey: null, customerIndex: null, walkInName: '散客 (Thomas)', notes: 'Thursday evening walk-in', source: 'desk' },
    { time: '19:00', serviceKey: 'aha60', staffKey: 'amy5', resourceKey: 'room1', customerIndex: 26, notes: 'AHA Glow 60 min facial', source: 'web' },
  ],
  // Day 7 (Friday 2026-09-25)
  [
    { time: '10:00', serviceKey: 'relax60', staffKey: 'amy1', resourceKey: null, customerIndex: 31, notes: 'Friday morning calm start', source: 'web' },
    { time: '10:30', serviceKey: 'dt60', staffKey: 'amy6', resourceKey: 'room1', customerIndex: 33, notes: 'Deep tissue, hot stones on back', addons: ['hotStone'], source: 'desk' },
    { time: '11:30', serviceKey: 'oxygen70', staffKey: 'amy3', resourceKey: null, customerIndex: 14, isRequest: true, notes: 'Weekend prep oxygen lifting facial', source: 'web' },
    { time: '13:00', serviceKey: 'combo60', staffKey: 'amy8', resourceKey: null, customerIndex: 1, notes: 'Combination full body', source: 'desk' },
    { time: '14:00', serviceKey: 'prenatal60', staffKey: 'amy4', resourceKey: null, customerIndex: 18, notes: 'Prenatal soothing session', source: 'phone_ai' },
    { time: '15:00', serviceKey: 'dt90', staffKey: 'amy1', resourceKey: 'room1', customerIndex: 19, isRequest: true, notes: 'Deep tissue firm pressure 90min', source: 'desk' },
    { time: '16:30', serviceKey: 'couples60', staffKey: 'amy2', resourceKey: 'couples', customerIndex: 32, notes: 'Friday date night couples massage', addons: ['aromaOil'], source: 'web' },
    { time: '17:30', serviceKey: 'manFacial50', staffKey: 'amy5', resourceKey: null, customerIndex: 25, notes: 'Men facial cleanup', source: 'desk' },
    { time: '18:30', serviceKey: 'relax90', staffKey: 'amy3', resourceKey: null, customerIndex: 29, notes: 'Friday wind-down 90 mins', source: 'phone_ai' },
    { time: '19:30', serviceKey: 'aha30', staffKey: 'amy6', resourceKey: null, customerIndex: 24, notes: 'Express 30min glow', source: 'web' },
  ],
  // Day 8 (Saturday 2026-09-26)
  [
    { time: '10:00', serviceKey: 'dt90', staffKey: 'amy1', resourceKey: 'room1', customerIndex: 0, isRequest: true, notes: 'Emily Watson weekend appointment', addons: ['cupping'], source: 'desk' },
    { time: '10:30', serviceKey: 'vitC60', staffKey: 'amy4', resourceKey: null, customerIndex: 34, notes: 'Vitamin C facial glow', addons: ['ledLight'], source: 'web' },
    { time: '11:30', serviceKey: 'relax60', staffKey: 'amy5', resourceKey: null, customerIndex: 6, notes: 'Aroma oil relaxation', addons: ['aromaOil'], source: 'desk' },
    { time: '12:30', serviceKey: 'aha60', staffKey: 'amy2', resourceKey: null, customerIndex: 10, isRequest: true, notes: 'AHA Glow 60 min', source: 'web' },
    { time: '13:30', serviceKey: 'combo90', staffKey: 'amy8', resourceKey: null, customerIndex: 9, notes: 'Weekend 90 min combo', source: 'phone_ai' },
    { time: '14:30', serviceKey: 'tmj60', staffKey: 'amy3', resourceKey: 'room1', customerIndex: 21, notes: 'Jaw & neck tension relief', source: 'desk' },
    { time: '15:30', serviceKey: 'myo60', staffKey: 'amy6', resourceKey: null, customerIndex: 17, notes: 'Myofascial release', source: 'desk' },
    { time: '16:30', serviceKey: 'execFacial80', staffKey: 'amy1', resourceKey: null, customerIndex: 16, isRequest: true, notes: 'Executive facial with Amy1', source: 'web' },
    { time: '18:00', serviceKey: 'dt60', staffKey: 'amy2', resourceKey: 'room1', customerIndex: null, walkInName: '散客 (Jason K.)', notes: 'Saturday evening walk-in', source: 'desk' },
    { time: '19:00', serviceKey: 'relax60', staffKey: 'amy5', resourceKey: null, customerIndex: 15, notes: 'Relaxation massage to end the week', source: 'phone_ai' },
  ],
];

const DATES = [
  '2026-09-19',
  '2026-09-20',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
];

async function main() {
  console.log('=== SEEDING REALISTIC APPOINTMENTS FOR OASIS SPA (V1 PROD) ===');

  // 1. Ensure customers in DB
  console.log('Step 1: Upserting realistic customer records...');
  const customerIdMap: string[] = [];

  for (const c of CUSTOMER_DEFS) {
    const [existing] = await sql`
      SELECT id FROM customers WHERE org_id = ${ORG_ID} AND phone_e164 = ${c.phone} LIMIT 1
    `;

    if (existing) {
      customerIdMap.push(existing.id);
    } else {
      const newId = randomUUID();
      await sql`
        INSERT INTO customers (
          id, org_id, primary_location_id, display_name, first_name, last_name,
          phone_e164, email, locale, gender, notes, tags,
          marketing_sms_opt_in, marketing_email_opt_in, source
        ) VALUES (
          ${newId}, ${ORG_ID}, ${LOC_ID}, ${c.name}, ${c.first}, ${c.last},
          ${c.phone}, ${c.email}, 'en', ${c.gender}, ${c.notes}, ${c.tags},
          false, false, 'desk'
        )
      `;
      customerIdMap.push(newId);
    }
  }
  console.log(`✓ ${customerIdMap.length} customers ready.`);

  // 2. Generate appointments for 8 days
  console.log('Step 2: Inserting appointments and items...');
  let totalApptsCreated = 0;
  let totalItemsCreated = 0;

  for (let d = 0; d < DATES.length; d++) {
    const bDate = DATES[d];
    const template = DAY_TEMPLATES[d];
    console.log(`\nProcessing date ${bDate} (${d + 1}/${DATES.length})...`);

    const existingOnDate = await sql`
      SELECT id FROM appointments WHERE location_id = ${LOC_ID} AND business_date = ${bDate}
    `;
    if (existingOnDate.length > 0) {
      console.log(`Found ${existingOnDate.length} existing appointments on ${bDate}, cleaning up...`);
      for (const e of existingOnDate) {
        await sql`DELETE FROM appointment_items WHERE appointment_id = ${e.id}`;
        await sql`DELETE FROM appointments WHERE id = ${e.id}`;
      }
    }

    for (let slotIdx = 0; slotIdx < template.length; slotIdx++) {
      const slot = template[slotIdx];
      const srv = SERVICES[slot.serviceKey];
      const staffId = STAFF[slot.staffKey];
      const resId = slot.resourceKey ? RES[slot.resourceKey] : null;
      const custId = slot.customerIndex !== null ? customerIdMap[slot.customerIndex] : null;
      const walkIn = slot.walkInName ?? null;

      // EDT times (-04:00)
      const startIso = `${bDate}T${slot.time}:00-04:00`;
      const startDate = new Date(startIso);
      const endDate = new Date(startDate.getTime() + srv.min * 60 * 1000);
      const endIso = endDate.toISOString();

      let apptStatus = 'booked';
      let itemStatus = 'booked';

      if (bDate === '2026-09-19') {
        const [hh, mm] = slot.time.split(':').map(Number);
        const slotMinutes = hh * 60 + mm;
        // Slots up to 11:30 AM mark as checked_in for realism
        if (slotMinutes <= 11 * 60 + 30) {
          apptStatus = 'checked_in';
          itemStatus = 'in_service';
        }
      }

      const apptId = randomUUID();
      const code = `OA${(Math.floor(1000 + Math.random() * 9000))}`;
      const addonUuids = (slot.addons ?? []).map(a => ADDONS[a]);

      let priceCents = srv.cents;
      if (slot.addons?.includes('hotStone')) priceCents += 1000;
      if (slot.addons?.includes('aromaOil')) priceCents += 1000;
      if (slot.addons?.includes('cupping')) priceCents += 3000;
      if (slot.addons?.includes('guasha')) priceCents += 3000;
      if (slot.addons?.includes('ledLight')) priceCents += 3000;

      await sql`
        INSERT INTO appointments (
          id, org_id, location_id, customer_id, walk_in_name,
          business_date, starts_at, ends_at, status, source,
          party_size, notes, created_by, confirmation_code
        ) VALUES (
          ${apptId}, ${ORG_ID}, ${LOC_ID}, ${custId}, ${walkIn},
          ${bDate}, ${startDate.toISOString()}, ${endIso}, ${apptStatus}, ${slot.source ?? 'desk'},
          1, ${slot.notes ?? null}, ${CREATED_BY}, ${code}
        )
      `;
      totalApptsCreated++;

      const itemId = randomUUID();
      await sql`
        INSERT INTO appointment_items (
          id, org_id, location_id, appointment_id, service_id,
          addon_ids, membership_id, is_request, resource_id,
          starts_at, ends_at, price_cents_snapshot, duration_min,
          seq, status, overbooked, details
        ) VALUES (
          ${itemId}, ${ORG_ID}, ${LOC_ID}, ${apptId}, ${srv.id},
          ${addonUuids}, ${staffId}, ${slot.isRequest ?? false}, ${resId},
          ${startDate.toISOString()}, ${endIso}, ${priceCents}, ${srv.min},
          0, ${itemStatus}, false, ${JSON.stringify({ notes: slot.notes ?? '' })}
        )
      `;
      totalItemsCreated++;
    }
  }

  console.log('\n=== INSERTION COMPLETE ===');
  console.log(`Total appointments created: ${totalApptsCreated}`);
  console.log(`Total appointment items created: ${totalItemsCreated}`);

  await sql.end();
}

main().catch((e) => {
  console.error('Failed to seed appointments:', e);
  process.exit(1);
});
