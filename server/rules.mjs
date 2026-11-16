// Safety rules. These run in code, before and after the model. The model is never trusted with them alone.
export const CLINIC_PHONE = '0770 980 4412';

export const EMERGENCY = /نزيف|ينزف|ما يوقف|مايوقف|ما وقف|صعوبة.*(التنفس|البلع)|ضيق.*النفس|تورم.*(الوجه|الحلق)|حرارة|حمى|bleed|breath|swallow|fever/i;
export const MED_CHANGE = /أوقف|اوقف|أقطع|اقطع|ابدل|أبدل|غير الدوا|حبتين|جرعتين|ضاعف|أضاعف|اضاعف|أزيد|ازيد|وقف.*الدوا/i;
export const PENICILLIN_ALLERGY = /بنسلين|penicillin|أموكسي|اموكسي|امكسي|amoxi/i;
export const ANTIBIOTIC_Q = /مضاد|أموكسي|اموكسي|امكسي|بنسلين|antibiot|amoxi|penicil/i;
// The model puts this marker at the start of an answer when the doctor must look at the case.
export const REVIEW_MARK = /\[يحتاج رأي الطبيب\]/;

export const TEXT = {
  emergency: () => `اللي توصفه يحتاج تواصل مباشر مع العيادة الآن.\n• اضغط على شاش نظيف مكان القلع 30 دقيقة بدون ما ترفعه.\n• اتصل بالعيادة: ${CLINIC_PHONE}\n• إذا النزيف شديد أو عندك صعوبة في التنفس أو البلع، روح لأقرب طوارئ فوراً.\nأرسلنا تنبيهاً للدكتور مصطفى الآن.`,
  refer: 'هذا السؤال يحتاج قرار الطبيب مباشرة، فلا أغيّر ولا أوقف أي دواء. أرسلته للدكتور مصطفى، ويوصلك جوابه هنا. لحد ذاك التزم بالوصفة كما هي.',
  penicillin: 'انتبه: في ملفك حساسية من البنسلين، والأموكسيسيلين من نفس العائلة. لا تاخذ هذا الدواء قبل ما يراجعك الدكتور. أرسلت سؤالك للدكتور مصطفى الآن.',
  review: 'سؤالك يحتاج مراجعة الدكتور مصطفى. أرسلته له، ويوصلك جوابه هنا.',
  fallback: 'ما قدرت أجاوب الحين. أرسلت سؤالك للدكتور مصطفى، ويوصلك جوابه هنا.',
  saved: 'شكراً، سجلت ذلك.',
  askNext: 'شكراً، سجلت ذلك. أرسل سؤالك الآن.',
};

// Intake is needed when the doctor has not recorded allergies, chronic illness, or (for women) pregnancy.
export function needIntake(p) {
  return !p.intake.done && (p.allergies == null || p.chronic == null || (p.sex === 'f' && p.pregnant == null));
}

export function intakeQuestion(p) {
  const female = p.sex === 'f';
  return `قبل ما أجاوب، لازم أعرف بعض المعلومات:\n1) هل عندك حساسية من أي دواء أو مادة؟\n2) هل عندك أمراض مزمنة (سكر، ضغط، قلب، ربو...) أو تاخذ أدوية بشكل مستمر؟${female ? '\n3) هل أنتِ حامل أو مرضعة؟' : ''}\nجاوب بكلمات بسيطة، وأنا أسجلها في ملفك.`;
}

export function penicillinConflict(p, question) {
  return PENICILLIN_ALLERGY.test(JSON.stringify(p.allergies ?? [])) && ANTIBIOTIC_Q.test(question);
}
