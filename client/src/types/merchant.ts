export interface MerchantLocation {
  latitude: number;
  longitude: number;
}

export interface MerchantSearchResult {
  placeId: string;
  businessName: string | null;
  formattedAddress: string | null;
  location: MerchantLocation | null;
  internationalPhoneNumber: string | null;
  nationalPhoneNumber: string | null;
  websiteUrl: string | null;
  businessStatus: string | null;
  googleMapsUrl: string | null;
}

export interface MerchantSearchResponse {
  results: MerchantSearchResult[];
  resultCount: number;
  pageCount: number;
  possiblyTruncated: boolean;
  partial: boolean;
  warning?: string;
}

export interface MerchantWebsiteExtraction {
  placeId: string;
  sourceUrl: string;
  emails: string[];
  phones: string[];
  pageTitle: string | null;
  pageDescription: string | null;
  canonicalUrl: string | null;
  cleanedWebsiteText: string;
  textTruncated: boolean;
}

export interface MerchantWebsiteExtractionState {
  status: 'pending' | 'loading' | 'success' | 'failed';
  data?: MerchantWebsiteExtraction;
  error?: string;
}

export type MerchantVerificationStatus = 'unverified' | 'verified';

export interface MerchantRecord {
  placeId: string;
  businessName: string;
  address: string;
  phone: string;
  emails: string[];
  websiteUrl: string;
  socialLinks: string[];
  pageTitle: string;
  pageDescription: string;
  cleanedWebsiteText: string;
  notes: string;
  verificationStatus: MerchantVerificationStatus;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantRecordPatch {
  placeId: string;
  businessName?: string;
  address?: string;
  phone?: string;
  emails?: string[];
  websiteUrl?: string;
  socialLinks?: string[];
  pageTitle?: string;
  pageDescription?: string;
  cleanedWebsiteText?: string;
  notes?: string;
  verificationStatus?: MerchantVerificationStatus;
  verifiedAt?: string;
  createdAt?: string;
}
