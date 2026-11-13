/**
 * Demonstration terms. Placeholder text for development and test only: it is not legal text,
 * has not been reviewed by a lawyer, and recording that a person saw it is not acceptance of
 * approved terms. Production registration stays closed until approved terms exist.
 */
export const TERMS_LANGUAGES = ['en', 'ar', 'ur'] as const;
export type TermsLanguage = (typeof TERMS_LANGUAGES)[number];

export const DEMONSTRATION_TERMS_VERSION = 'demonstration-2026-11-13';

export interface TermsText {
  readonly kind: 'demonstration';
  readonly version: string;
  readonly language: TermsLanguage;
  readonly title: string;
  readonly notice: string;
  readonly paragraphs: readonly string[];
}

const TEXT: Record<TermsLanguage, Omit<TermsText, 'kind' | 'version' | 'language'>> = {
  en: {
    title: 'Demonstration terms',
    notice:
      'This is placeholder text for development and testing. It is not a legal agreement and creates no rights or duties.',
    paragraphs: [
      'This build of Trucker is not a live service. Nothing you enter here is used to arrange transport.',
      'The real terms of use and privacy notice have not been written or approved. They will replace this text before any real registration is possible.',
      'By continuing you confirm only that you have seen this notice.',
    ],
  },
  ar: {
    title: 'شروط تجريبية',
    notice:
      'هذا نص مؤقت لأغراض التطوير والاختبار. ليس اتفاقية قانونية ولا يُنشئ أي حقوق أو التزامات.',
    paragraphs: [
      'هذه النسخة من Trucker ليست خدمة متاحة. لا يُستخدَم أي شيء تُدخله هنا لترتيب النقل.',
      'لم تُكتَب شروط الاستخدام وإشعار الخصوصية الحقيقيان ولم يُعتمَدا بعد. سيحلّان محل هذا النص قبل إتاحة أي تسجيل حقيقي.',
      'بمتابعتك تؤكد فقط أنك اطّلعت على هذا التنبيه.',
    ],
  },
  ur: {
    title: 'نمائشی شرائط',
    notice:
      'یہ تیاری اور جانچ کے لیے عارضی متن ہے۔ یہ کوئی قانونی معاہدہ نہیں اور اس سے کوئی حق یا ذمہ داری پیدا نہیں ہوتی۔',
    paragraphs: [
      'Trucker کا یہ نسخہ دستیاب سروس نہیں ہے۔ یہاں درج کی گئی کوئی چیز نقل و حمل کے انتظام کے لیے استعمال نہیں ہوتی۔',
      'استعمال کی اصل شرائط اور رازداری کا نوٹس ابھی نہ لکھے گئے ہیں نہ منظور ہوئے ہیں۔ کسی حقیقی رجسٹریشن سے پہلے وہ اس متن کی جگہ لیں گے۔',
      'آگے بڑھ کر آپ صرف یہ تصدیق کرتے ہیں کہ آپ نے یہ نوٹس دیکھ لیا ہے۔',
    ],
  },
};

export function isTermsLanguage(value: unknown): value is TermsLanguage {
  return typeof value === 'string' && (TERMS_LANGUAGES as readonly string[]).includes(value);
}

export function demonstrationTerms(language: TermsLanguage): TermsText {
  return {
    kind: 'demonstration',
    version: DEMONSTRATION_TERMS_VERSION,
    language,
    ...TEXT[language],
  };
}
