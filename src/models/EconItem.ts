export interface SteamTag {
  category: string;
  internal_name: string;
  localized_category_name?: string;
  category_name?: string;
  localized_tag_name?: string;
  name?: string;
  color?: string;
}

export interface SteamDescriptionLine {
  type: string;
  value: string;
  color?: string;
  name?: string;
}

export interface SteamAction {
  link: string;
  name: string;
  type?: string;
}

export interface AssetProperty {
  propertyid: number;
  int_value?: string;
  float_value?: string;
  string_value?: string;
}

export interface RawInventoryAsset {
  appid?: number | string;
  contextid?: string;
  assetid?: string;
  id?: string;
  classid: string;
  instanceid?: string;
  amount: string;
  currencyid?: string;
  pos?: number;
  [key: string]: unknown;
}

export interface RawDescription {
  appid?: number | string;
  classid: string;
  instanceid?: string;
  icon_url?: string;
  name?: string;
  type?: string;
  market_name?: string;
  market_hash_name?: string;
  tradable?: number | boolean;
  marketable?: number | boolean;
  commodity?: number | boolean;
  market_tradable_restriction?: number | string;
  market_marketable_restriction?: number | string;
  descriptions?: SteamDescriptionLine[];
  owner_descriptions?: SteamDescriptionLine[];
  actions?: SteamAction[];
  market_actions?: SteamAction[];
  fraudwarnings?: string[];
  tags?: SteamTag[];
  [key: string]: unknown;
}

export interface RawAssetPropertyEntry {
  appid: number;
  contextid: string;
  assetid: string;
  asset_properties: AssetProperty[];
}

export interface RawInventoryResponse {
  assets?: RawInventoryAsset[];
  descriptions?: RawDescription[];
  asset_properties?: RawAssetPropertyEntry[];
  more_items?: number;
  last_assetid?: string;
  total_inventory_count?: number;
  success?: number;
  error?: string;
  Error?: string;
}

export interface RawPartnerInventoryResponse {
  success?: boolean;
  error?: string;
  rgInventory?: Record<string, RawInventoryAsset> | unknown[];
  rgDescriptions?: Record<string, RawDescription> | unknown[];
  rgAssetProperties?: Record<string, AssetProperty[]> | unknown[];
  more?: boolean;
  more_start?: number | boolean;
}

export interface EconItem {
  appid: number;
  contextid: string;
  assetid: string;
  classid: string;
  instanceid: string;
  amount: number;
  currencyid?: string;

  name: string;
  market_name: string;
  market_hash_name: string;
  type: string;
  name_color?: string;
  background_color?: string;
  icon_url: string;
  icon_url_large?: string;

  tradable: boolean;
  marketable: boolean;
  commodity: boolean;
  market_tradable_restriction: number;
  market_marketable_restriction: number;

  descriptions: SteamDescriptionLine[];
  owner_descriptions: SteamDescriptionLine[];
  actions: SteamAction[];
  market_actions: SteamAction[];
  fraudwarnings: string[];
  tags: SteamTag[];
  asset_properties: AssetProperty[];

  [key: string]: unknown;
}

function toBool(value: number | boolean | undefined): boolean {
  return typeof value === "boolean" ? value : Number(value ?? 0) !== 0;
}

function toInt(value: number | string | undefined): number {
  return value ? Number.parseInt(String(value), 10) : 0;
}

function asRecord<T>(value: Record<string, T> | unknown[] | undefined): Record<string, T> {
  return value && !Array.isArray(value) ? value : {};
}

// Key by appid_classid_instanceid: trade offers span multiple apps, so appid must be in the key (unlike single-app inventory).
export function buildDescriptionMap(
  descriptions: RawDescription[] | undefined,
): Map<string, RawDescription> {
  const map = new Map<string, RawDescription>();
  for (const d of descriptions ?? []) {
    map.set(`${d.appid}_${d.classid}_${d.instanceid ?? "0"}`, d);
  }
  return map;
}

export function buildItem(
  asset: RawInventoryAsset,
  description: RawDescription | undefined,
  properties: AssetProperty[],
  fallbackContextId: string,
): EconItem {
  return {
    ...asset,
    ...description,
    appid: Number(asset.appid ?? description?.appid ?? 0),
    contextid: (asset.contextid ?? fallbackContextId).toString(),
    assetid: (asset.assetid ?? asset.id ?? "").toString(),
    classid: asset.classid.toString(),
    instanceid: (asset.instanceid ?? "0").toString(),
    amount: toInt(asset.amount),
    ...(asset.currencyid ? { currencyid: asset.currencyid } : {}),
    name: description?.name ?? "",
    market_name: description?.market_name ?? "",
    market_hash_name: description?.market_hash_name ?? "",
    type: description?.type ?? "",
    icon_url: description?.icon_url ?? "",
    tradable: toBool(description?.tradable),
    marketable: toBool(description?.marketable),
    commodity: toBool(description?.commodity),
    market_tradable_restriction: toInt(description?.market_tradable_restriction),
    market_marketable_restriction: toInt(description?.market_marketable_restriction),
    descriptions: description?.descriptions ?? [],
    owner_descriptions: description?.owner_descriptions ?? [],
    actions: description?.actions ?? [],
    market_actions: description?.market_actions ?? [],
    fraudwarnings: description?.fraudwarnings ?? [],
    tags: description?.tags ?? [],
    asset_properties: properties,
  };
}

export function parseInventory(
  body: RawInventoryResponse,
  contextid: string,
  tradableOnly = false,
): EconItem[] {
  const descriptions = new Map<string, RawDescription>();
  for (const d of body.descriptions ?? []) {
    descriptions.set(`${d.classid}_${d.instanceid ?? "0"}`, d);
  }

  const properties = new Map<string, AssetProperty[]>();
  for (const p of body.asset_properties ?? []) {
    properties.set(p.assetid, p.asset_properties);
  }

  const items: EconItem[] = [];
  for (const asset of body.assets ?? []) {
    const assetid = (asset.assetid ?? asset.id ?? "").toString();
    const description = descriptions.get(`${asset.classid}_${asset.instanceid ?? "0"}`);
    if (tradableOnly && !toBool(description?.tradable)) continue;
    items.push(buildItem(asset, description, properties.get(assetid) ?? [], contextid));
  }
  return items;
}

export function parsePartnerInventory(
  body: RawPartnerInventoryResponse,
  contextid: string,
  tradableOnly = false,
): EconItem[] {
  const inventory = asRecord<RawInventoryAsset>(body.rgInventory);
  const descriptions = asRecord<RawDescription>(body.rgDescriptions);
  const properties = asRecord<AssetProperty[]>(body.rgAssetProperties);

  const assets = Object.values(inventory).sort((a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0));
  const items: EconItem[] = [];
  for (const asset of assets) {
    const description = descriptions[`${asset.classid}_${asset.instanceid ?? "0"}`];
    if (tradableOnly && !toBool(description?.tradable)) continue;
    const assetid = (asset.assetid ?? asset.id ?? "").toString();
    items.push(buildItem(asset, description, properties[assetid] ?? [], contextid));
  }
  return items;
}
