import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseInventory,
  parsePartnerInventory,
  type RawInventoryResponse,
  type RawPartnerInventoryResponse,
} from "../src/models/EconItem.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const cs2 = fixture<RawInventoryResponse>("cs2-inventory.json");
const rust = fixture<RawInventoryResponse>("rust-inventory.json");
const partner = fixture<RawPartnerInventoryResponse>("partnerinventory.json");

describe("parseInventory — CS2", () => {
  const items = parseInventory(cs2, "2");

  it("parses every asset and merges its description (faithful snake_case)", () => {
    expect(items).toHaveLength(3);
    const mp9 = items[0];
    expect(mp9?.assetid).toBe("51745566387");
    expect(mp9?.market_hash_name).toBe("MP9 | Bee-Tron (Field-Tested)");
    expect(mp9?.type).toBe("Consumer Grade SMG");
    expect(mp9?.icon_url).toBe("i0CoZ81Ui0m-9KwlBY1L_MP9");
  });

  it("coerces tradable/marketable/commodity to booleans and restrictions to ints", () => {
    expect(items[0]?.tradable).toBe(true);
    expect(items[0]?.commodity).toBe(false);
    expect(items[1]?.commodity).toBe(true);
    expect(items[0]?.market_tradable_restriction).toBe(7);
  });

  it("keeps asset_properties as-is (no hoisting); float/seed live in there", () => {
    const props = items[0]?.asset_properties;
    expect(props?.find((p) => p.propertyid === 1)?.int_value).toBe("70");
    expect(props?.find((p) => p.propertyid === 2)?.float_value).toBe("0.252766847610473633");
    expect(props?.find((p) => p.propertyid === 6)?.string_value).toBe(
      "C5D576185F2705C4DDE7E529CFEDC4F5C1FD6D104031C68583AD03C6B5DDAD9DE711",
    );
    expect(items[1]?.asset_properties).toEqual([]);
  });

  it("is lossless — keeps fields we never explicitly modelled", () => {
    expect(items[0]?.sealed).toBe(0);
    expect(items[1]?.sealed_type).toBe(0);
  });

  it("keeps tags in Steam's raw shape", () => {
    const weapon = items[0]?.tags.find((t) => t.category === "Weapon");
    expect(weapon?.localized_tag_name).toBe("MP9");
    expect(weapon?.internal_name).toBe("weapon_mp9");
  });
});

describe("parseInventory — Rust", () => {
  const items = parseInventory(rust, "2");

  it("parses stackable amounts and names", () => {
    expect(items).toHaveLength(3);
    expect(items[0]?.amount).toBe(78);
    expect(items[0]?.market_hash_name).toBe("Thundergold Roadsign Gloves");
    expect(items[1]?.amount).toBe(412);
    expect(items[2]?.amount).toBe(1);
  });

  it("keeps owner_descriptions and the large icon", () => {
    expect(items[0]?.owner_descriptions?.[0]?.color).toBe("55FF55");
    expect(items[0]?.icon_url_large).toContain("DEiv5dYMKg");
  });
});

describe("parseInventory — tradableOnly", () => {
  it("keeps all tradable fixtures (none are untradable here)", () => {
    expect(parseInventory(cs2, "2", true)).toHaveLength(3);
  });
});

describe("parsePartnerInventory — old rgInventory format", () => {
  const items = parsePartnerInventory(partner, "2");

  it("normalizes the old object-keyed shape into EconItem[], ordered by pos", () => {
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.market_hash_name)).toEqual([
      "Sealed Graffiti | King Me (Desert Amber)",
      "MP7 | Coral Paisley (Field-Tested)",
      "MP7 | Fade (Factory New)",
    ]);
  });

  it("coerces string appid/restrictions and uses id as assetid", () => {
    const mp7 = items[1];
    expect(mp7?.appid).toBe(730);
    expect(mp7?.assetid).toBe("51691623399");
    expect(mp7?.market_tradable_restriction).toBe(7);
    expect(mp7?.commodity).toBe(false);
  });

  it("merges rgAssetProperties (floats) by assetid", () => {
    const props = items[1]?.asset_properties;
    expect(props?.find((p) => p.propertyid === 1)?.int_value).toBe("678");
    expect(props?.find((p) => p.propertyid === 2)?.float_value).toBe("0.240212");
    expect(items[0]?.asset_properties).toEqual([]);
  });

  it("keeps stickers/charms as raw HTML description lines (lossless)", () => {
    const fade = items[2];
    const sticker = fade?.descriptions.find((d) => d.name === "sticker_info");
    const charm = fade?.descriptions.find((d) => d.name === "keychain_info");
    expect(sticker?.value).toContain("Natus Vincere | Budapest 2025");
    expect(charm?.value).toContain("Charm: Lil' No. 2");
  });
});
