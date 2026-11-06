const html = "text/html";
export const markdown = "text/markdown";

export function preferredRepresentation(accept: string | null) {
  if (!accept?.trim()) return html;

  const ranges = (accept.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g) ?? []).map((range) => {
    const [type, ...parameters] = range
      .toLowerCase()
      .split(";")
      .map((part) => part.trim());
    const weightIndex = parameters.findIndex((part) => part.startsWith("q="));
    const weight = parameters[weightIndex]?.slice(2);
    const mediaParameters = weightIndex === -1 ? parameters : parameters.slice(0, weightIndex);
    const charset =
      mediaParameters.length === 1 && /^charset=(?:utf-8|"utf-8")$/.test(mediaParameters[0] ?? "");
    return {
      type,
      charset,
      matches: mediaParameters.length === 0 || charset,
      quality:
        weight === undefined
          ? 1
          : /^[01](?:\.\d{0,3})?$/.test(weight) && Number(weight) <= 1
            ? Number(weight)
            : 0,
    };
  });

  function preference(type: string) {
    let quality = 0;
    let specificity = -1;
    for (const range of ranges) {
      if (!range.matches) continue;
      const match =
        range.type === type ? 2 : range.type === "text/*" ? 1 : range.type === "*/*" ? 0 : -1;
      if (match < 0) continue;
      const priority = match * 2 + Number(range.charset);
      if (priority > specificity || (priority === specificity && range.quality > quality)) {
        specificity = priority;
        quality = range.quality;
      }
    }
    return { quality, specificity };
  }

  const browser = preference(html);
  const agent = preference(markdown);
  if (
    agent.quality > browser.quality ||
    (agent.quality > 0 &&
      agent.quality === browser.quality &&
      agent.specificity > browser.specificity)
  )
    return markdown;
  return browser.quality > 0 ? html : null;
}
