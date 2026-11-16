// Demo patients, inserted only when the database is empty. Replace them from the doctor console.
import { patientCount, upsertPatient } from './db.mjs';

const DEMO = [
  {
    id: 'MK-0142', name: 'أحمد علي حسن', sex: 'm', age: 34, phone: '0770 123 4567',
    allergies: null, chronic: null, pregnant: null,
    medications: ['أموكسيسيلين 500 ملغ، كل 8 ساعات، 5 أيام', 'إيبوبروفين 400 ملغ عند الألم فقط، حد أقصى 3 حبات باليوم'],
    treatment: 'قلع ضرس العقل السفلي الأيسر (38) قبل يوم. موعد فك الغرز بعد 6 أيام',
    doctorNotes: '', details: '',
  },
  {
    id: 'MK-0200', name: 'سارة (حالة تجريبية)', sex: 'f', age: 29, phone: '',
    allergies: ['بنسلين'], chronic: [], pregnant: true,
    medications: [], treatment: 'حشوة سن 24',
    doctorNotes: 'حامل في الشهر الرابع. لا تُقترح أي أدوية بدون الرجوع للطبيب.',
    details: 'بيانات تجريبية، عدّلها من لوحة الطبيب.',
  },
];

export function seedIfEmpty(db) {
  if (patientCount(db) > 0) return;
  for (const p of DEMO) upsertPatient(db, { ...p, intake: { asked: false, done: false, raw: '', pendingQuestion: '' } });
  console.log(`seeded ${DEMO.length} demo patients`);
}
