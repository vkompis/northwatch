/**
 * Place names on the basemap in the visitor's language. The styles (public/styles/svalmap-*.json)
 * ask for the Norwegian name first; a browser that does not list Norwegian gets the English
 * name instead. The tiles (OpenMapTiles schema) carry both.
 */

export type LabelLanguage = 'no' | 'en';

const NORWEGIAN = /^(nb|nn|no)(-|$)/i;

/** Norwegian when the browser lists Norwegian among its languages, English otherwise */
export function browserLabelLanguage(languages?: readonly string[]): LabelLanguage {
  const list =
    languages ??
    (typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
  return list.some((l) => NORWEGIAN.test(String(l || ''))) ? 'no' : 'en';
}

/** English name, then the international and local ones */
const ENGLISH_NAME = ['coalesce', ['get', 'name_en'], ['get', 'name:en'], ['get', 'name_int'], ['get', 'name']];

/**
 * The style with every label that asks for a Norwegian name asking for the English one instead
 * (Norwegian sea and city spellings in `match` expressions go too). Road numbers and other
 * labels are left alone.
 */
export function localiseStyleLabels<T extends { layers?: any[] }>(style: T, language: LabelLanguage): T {
  if (language === 'no' || !Array.isArray(style?.layers)) return style;
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const field = layer?.layout?.['text-field'];
      if (!field || !/"name(_no|:no)"/.test(JSON.stringify(field))) return layer;
      return { ...layer, layout: { ...layer.layout, 'text-field': ENGLISH_NAME } };
    }),
  };
}
