// Model side: builds the prompt from the patient's record and conversation, calls LM Studio.
export const LM_URL = (process.env.LM_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
export const LM_MODEL = process.env.LM_MODEL || 'qwen/qwen3.6-35b-a3b';

export const SYSTEM = `أنت مساعد عيادة د. مصطفى كمال لطب الأسنان. تجاوب المريض بالعربية البسيطة المهنية.
قواعد إلزامية:
1. استخدم "ملف المريض" المرفق وأجب حسب حال هذا المريض بالذات. إذا معلومة غير موجودة في الملف، قل إنها غير مسجلة ولا تفترضها.
2. اكتب المصطلحات الطبية بالإنجليزي بين قوسين بعد الشرح العربي، والجرعات والأوقات بالعربي مع الوحدات.
3. لا تصف دواءً جديداً، ولا تغيّر جرعة، ولا توقف دواءً. هذا قرار الطبيب فقط.
4. إذا عند المريض حساسية من دواء، لا تقترح أي دواء من نفس العائلة.
5. إذا المريضة حامل أو مرضعة، لا تقترح أي دواء أو عشبة بدون رجوع للطبيب.
6. إذا السؤال يحتاج رأي الطبيب (تشخيص، أعراض مقلقة، قرار علاجي)، ابدأ ردك بالعلامة [يحتاج رأي الطبيب] ثم قل للمريض إن الدكتور سيراجع حالته. لا تقل إنك أرسلت السؤال، فالنظام هو من يرسله.
7. لا تشخّص، ولا تعطِ تطمينات قاطعة.
8. بدون إيموجي، وبأسلوب مختصر.`;

export function patientContext(p) {
  const list = v => (Array.isArray(v) && v.length ? v.join('، ') : 'لا يوجد مسجل');
  const lines = [
    `الاسم: ${p.name}`,
    `العمر: ${p.age ?? 'غير مسجل'}، الجنس: ${p.sex === 'f' ? 'أنثى' : 'ذكر'}`,
    `الحساسية المسجلة: ${p.allergies == null ? 'غير مسجلة بعد' : list(p.allergies)}`,
    `الأمراض المزمنة: ${p.chronic == null ? 'غير مسجلة بعد' : list(p.chronic)}`,
    `الحمل: ${p.sex === 'f' ? (p.pregnant == null ? 'غير مسجل' : p.pregnant ? 'حامل' : 'غير حامل') : 'لا ينطبق'}`,
    `الأدوية الحالية: ${list(p.medications)}`,
    `العلاج الحالي: ${p.treatment || 'غير مسجل'}`,
    `تعليمات الطبيب: ${p.doctorNotes || 'لا توجد'}`,
  ];
  if (p.details) lines.push(`تفاصيل إضافية من الطبيب: ${p.details}`);
  if (p.intake?.raw) lines.push(`ما قاله المريض بنفسه (غير مؤكد): ${p.intake.raw}`);
  return 'ملف المريض:\n' + lines.join('\n');
}

// Last messages of the conversation, so answers follow what was already said.
export function historyMessages(history) {
  return history.map(m => ({
    role: m.role === 'patient' ? 'user' : 'assistant',
    content: m.role === 'doctor' ? `[رد الدكتور مصطفى] ${m.text}` : m.text,
  }));
}

export function buildMessages(p, history, question, image) {
  const user = image
    ? { role: 'user', content: [{ type: 'text', text: question || 'اشرح هذه الصورة' }, { type: 'image_url', image_url: { url: image } }] }
    : { role: 'user', content: question };
  return [{ role: 'system', content: SYSTEM }, { role: 'system', content: patientContext(p) }, ...historyMessages(history), user];
}

export async function askModel(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const r = await fetch(`${LM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The model reasons before answering, so the budget is large.
      body: JSON.stringify({ model: LM_MODEL, messages, temperature: 0.2, max_tokens: 3000 }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`LM Studio HTTP ${r.status}`);
    const j = await r.json();
    // Keep only the answer: drop any <think> block and emoji (the clinic style forbids them).
    const text = String(j.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/\p{Extended_Pictographic}️?/gu, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) throw new Error('empty model reply');
    return text;
  } finally {
    clearTimeout(timer);
  }
}
