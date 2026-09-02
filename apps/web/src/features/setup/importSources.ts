export const STORE_IMPORT_SOURCES = ['yelp', 'website'] as const;
export const CATALOG_IMPORT_SOURCES = ['menu'] as const;

export type StoreImportSource = (typeof STORE_IMPORT_SOURCES)[number];
export type CatalogImportSource = (typeof CATALOG_IMPORT_SOURCES)[number];
