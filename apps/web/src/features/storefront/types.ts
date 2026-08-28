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
}