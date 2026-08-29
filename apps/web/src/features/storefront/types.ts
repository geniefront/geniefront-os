export interface BlueprintSummary {
  blueprintId: string;
  status: string;
  label: string | null;
  createdAt: string;
  itemCount: number;
}

export interface BlueprintsResponse {
  blueprints: BlueprintSummary[];
}

export interface SaveStorefrontBriefInput {
  currentSiteUrl?: string | null;
  hasNoSite?: boolean;
  painPoints?: string[];
  painFreeText?: string | null;
  audience?: string[];
  topQuestions?: string[];
  brandPrimary?: string | null;
  brandAccent?: string | null;
  voice?: "warm" | "luxury" | "modern" | "traditional" | null;
  sections?: string[];
  usp?: string | null;
  tone?: string | null;
  referenceSites?: string[];
  storeName?: string | null;
  slogan?: string | null;
  photoSourceUrl?: string | null;
}

export interface StorefrontDraftContent {
  variantLabel: string;
  hero: { headline: string; subhead: string; cta: string };
  about: string;
  faq: Array<{ q: string; a: string }>;
  sectionCopy: Record<string, string>;
}

export interface StorefrontDraft {
  draftId: string;
  variant: number;
  content: StorefrontDraftContent;
  chosenAt: string | null;
  model: string | null;
  createdAt: string;
}

export interface StorefrontBriefResponse {
  shopName: string;
  slogan: string;
  brief: (SaveStorefrontBriefInput & {
    id: string;
    status: 'draft' | 'withdrawn' | 'submitted' | 'drafted' | 'chosen' | 'live';
    submittedAt: string | null;
    draftedAt: string | null;
    liveAt: string | null;
    publicUrl: string | null;
    launchRequestedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }) | null;
  drafts: StorefrontDraft[];
}

export interface StorefrontRevision {
  id: string;
  text: string;
  status: 'submitted' | 'in_progress' | 'accepted' | 'declined';
  response: string | null;
  createdAt: string;
  updatedAt: string;
}
