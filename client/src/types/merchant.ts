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
