// JSON.stringify leaves non-ASCII characters (emoji, Cyrillic, extended
// Latin, …) as literal UTF-8 text, but HTTP header values must be Latin-1 —
// Node throws ERR_INVALID_CHAR if one slips in. Dashboard toasts built from
// live Discord data (a channel name, a custom command name, …) can contain
// anything, so JSON.stringify alone isn't safe to hand to res.set().
//
// Escaping every non-ASCII UTF-16 code unit as \uXXXX keeps the result valid
// JSON (JSON.parse decodes \u escapes normally, including matched surrogate
// pairs for characters outside the BMP) while guaranteeing the string itself
// is pure ASCII, which is always a legal header value.
export function headerJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}
