// dk-facility-icons.js -- local icon mapping for DK friluftsdata facilities

export const DK_FACILITY_ICON_SIZE_PX = 20;

const DK_FACILITY_ICON_BY_TYPE = new Map([
  ["Bålhytte", "assets/dk-facilities/Baalhytte_5800_3091.svg"],
  ["Baalhytte", "assets/dk-facilities/Baalhytte_5800_3091.svg"],
  ["Bålplads", "assets/dk-facilities/Baalplads_NST_5800_1022.svg"],
  ["Baalplads", "assets/dk-facilities/Baalplads_NST_5800_1022.svg"],
  ["Campingplads", "assets/dk-facilities/Campingplads_NST_5800_3041.svg"],
  ["Fri teltning", "assets/dk-facilities/Fri_Teltning_NST_5800_3071.svg"],
  ["Fri Teltning", "assets/dk-facilities/Fri_Teltning_NST_5800_3071.svg"],
  ["Shelter", "assets/dk-facilities/Shelter_NST_5800_3012.svg"],
  ["Teltplads", "assets/dk-facilities/Teltplads_NST_5800_3031.svg"],
  ["Toilet", "assets/dk-facilities/Toilet_NST_5800_1012.svg"],
  ["Vandpost", "assets/dk-facilities/Vandpost_NST_5800_1222.svg"],
]);

export function getDkFacilityIconPath(facilityType) {
  const key = String(facilityType || "").trim();
  if (!key) return null;
  return DK_FACILITY_ICON_BY_TYPE.get(key) || null;
}
