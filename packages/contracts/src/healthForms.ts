/** Shared health-form presentation metadata for Web, Kiosk, and API. */
export type HealthFormCategory = 'massage' | 'facial' | 'nail' | 'lash' | 'scalp' | 'hair';
export type AssessmentMode = 'pain_body_map' | 'skin' | 'nail_foot' | 'eye_lash' | 'scalp_neck' | 'hair';

export interface HealthFormExperience {
  category: HealthFormCategory;
  assessmentMode: AssessmentMode;
  label: string;
  safetyTitle: string;
  assessmentTitle: string;
  assessmentHint: string;
  safetyQuestionIds: string[];
  assessmentQuestionIds: string[];
}

export const HEALTH_FORM_EXPERIENCES: Record<HealthFormCategory, HealthFormExperience> = {
  massage: {
    category: 'massage', assessmentMode: 'pain_body_map', label: 'Massage & Spa',
    safetyTitle: '1. Health information and contraindications',
    assessmentTitle: '2. Pain assessment and body map',
    assessmentHint: 'Mark focus and avoid areas',
    safetyQuestionIds: ['q_pacemaker', 'q_blood_clots', 'q_heart_bp', 'q_spine_injuries', 'q_pregnancy', 'q_allergies', 'q_surgeries_meds'],
    assessmentQuestionIds: ['q_pressure_pref'],
  },
  facial: {
    category: 'facial', assessmentMode: 'skin', label: 'Facial & Skincare',
    safetyTitle: '1. Skin health and safety screening',
    assessmentTitle: '2. Skin condition and treatment goals',
    assessmentHint: 'Tell us about your skin today',
    safetyQuestionIds: ['q_recent_procedures', 'q_accutane_pregnancy', 'q_facial_allergies'],
    assessmentQuestionIds: ['q_skin_type', 'q_skincare_goals'],
  },
  nail: {
    category: 'nail', assessmentMode: 'nail_foot', label: 'Nail & Pedicure',
    safetyTitle: '1. Nail and foot health screening',
    assessmentTitle: '2. Service area and current symptoms',
    assessmentHint: 'No full-body map is needed',
    safetyQuestionIds: ['q_nail_fungus', 'q_nail_allergy', 'q_nail_wounds', 'q_diabetes_circulation'],
    assessmentQuestionIds: ['q_nail_service_area', 'q_nail_symptoms', 'q_nail_pref'],
  },
  lash: {
    category: 'lash', assessmentMode: 'eye_lash', label: 'Lash Services',
    safetyTitle: '1. Eye and lash safety screening',
    assessmentTitle: '2. Eye condition and service preferences',
    assessmentHint: 'Review sensitivity before adhesive service',
    safetyQuestionIds: ['q_lash_allergy', 'q_eye_surgery', 'q_eye_condition'],
    assessmentQuestionIds: ['q_contact_lenses', 'q_lash_reaction', 'q_lash_goal'],
  },
  scalp: {
    category: 'scalp', assessmentMode: 'scalp_neck', label: 'Head Spa & Scalp',
    safetyTitle: '1. Scalp and neck safety screening',
    assessmentTitle: '2. Scalp condition and neck comfort',
    assessmentHint: 'Review scalp sensitivity and washbasin comfort',
    safetyQuestionIds: ['q_hair_dye_allergy', 'q_scalp_wounds', 'q_recent_hair_treatment'],
    assessmentQuestionIds: ['q_scalp_condition', 'q_neck_tolerance'],
  },
  hair: {
    category: 'hair', assessmentMode: 'hair', label: 'Hair Services',
    safetyTitle: '1. Hair and scalp safety screening',
    assessmentTitle: '2. Hair condition and service goals',
    assessmentHint: 'Review chemical history before service',
    safetyQuestionIds: ['q_hair_chemical_allergy', 'q_hair_scalp_wounds', 'q_recent_chemical_service'],
    assessmentQuestionIds: ['q_hair_condition', 'q_hair_goal'],
  },
};

export const HEALTH_FORM_CATEGORY_OPTIONS = Object.values(HEALTH_FORM_EXPERIENCES).map(({ category, label }) => ({
  value: category,
  label,
}));

export function inferHealthFormCategory(templateKey: string): HealthFormCategory {
  if (templateKey.includes('facial')) return 'facial';
  if (templateKey.includes('lash')) return 'lash';
  if (templateKey.includes('nail') || templateKey.includes('pedi')) return 'nail';
  if (templateKey.includes('head_spa') || templateKey.includes('scalp')) return 'scalp';
  if (templateKey.includes('hair')) return 'hair';
  return 'massage';
}

export function categoryForBusinessType(businessType: string): HealthFormCategory {
  if (businessType === 'nail') return 'nail';
  if (businessType === 'lash') return 'lash';
  if (businessType === 'scalp') return 'scalp';
  if (businessType === 'hair') return 'hair';
  if (businessType === 'massage' || businessType === 'foot_spa') return 'massage';
  return 'nail';
}

export function healthFormTemplateKeyForBusinessType(businessType: string): string {
  return {
    nail: 'nail_pedicure_intake',
    massage: 'massage_intake',
    facial: 'facial_skincare_intake',
    lash: 'lash_services_intake',
    scalp: 'head_spa_intake',
    hair: 'hair_services_intake',
  }[categoryForBusinessType(businessType)];
}
