const rules = [
  {
    ruleId: 'H5A-DOC-001',
    message: 'A full document must start with the short HTML doctype.',
    expected: '<!doctype html> at the start of the document.',
    match(text) {
      return /^\s*<!doctype html(?:\s*)>/i.exec(text);
    },
    fails(text, match) {
      return match === null || match.index !== 0;
    }
  },
  {
    ruleId: 'H5A-DOC-002',
    message: 'The root html element needs a non-empty language.',
    expected: 'A non-empty lang attribute on the root html element.',
    match(text) {
      return /<html\b[^>]*\blang\s*=\s*(["'])([^"']+)\1/i.exec(text);
    },
    fails(_text, match) {
      return match === null || match[2].trim() === '';
    }
  },
  {
    ruleId: 'H5A-DOC-003',
    message: 'The document needs one non-empty title.',
    expected: 'Exactly one title element with non-whitespace text.',
    match(text) {
      return /<title\b[^>]*>([^<]+)<\/title\s*>/i.exec(text);
    },
    fails(text, match) {
      return (
        match === null || match[1].trim() === '' || (text.match(/<title\b/gi) ?? []).length !== 1
      );
    }
  },
  {
    ruleId: 'H5A-SEM-001',
    message: 'The page needs one primary main landmark.',
    expected: 'Exactly one main element.',
    match(text) {
      return /<main\b[^>]*>/i.exec(text);
    },
    fails(text) {
      return (text.match(/<main\b/gi) ?? []).length !== 1;
    }
  },
  {
    ruleId: 'H5A-SEM-002',
    message: 'A skip link must reach primary content.',
    expected: 'A local link whose fragment identifies the main element.',
    match(text) {
      const main = /<main\b[^>]*\bid\s*=\s*(["'])([^"']+)\1/i.exec(text);
      if (main === null) return null;
      const escaped = main[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*(["'])#${escaped}\\1`, 'i').exec(text);
    },
    fails(_text, match) {
      return match === null;
    }
  },
  {
    ruleId: 'H5A-A11Y-001',
    message: 'Every image must declare alternative-text intent.',
    expected: 'An alt attribute, including alt="" for a decorative image.',
    matches(text) {
      return [...text.matchAll(/<img\b[^>]*>/gi)].filter((entry) => !/\balt\s*=/i.test(entry[0]));
    }
  },
  {
    ruleId: 'H5A-A11Y-006',
    message: 'Positive tabindex values change the expected keyboard order.',
    expected: 'No tabindex value greater than zero.',
    matches(text) {
      return [...text.matchAll(/\btabindex\s*=\s*(["'])\s*([1-9]\d*)\s*\1/gi)];
    }
  },
  {
    ruleId: 'H5A-SAFE-001',
    message: 'Strict production pages cannot depend on a remote runtime origin.',
    expected: 'Only local runtime references.',
    matches(text) {
      return [
        ...text.matchAll(/\b(?:src|href|poster|action)\s*=\s*(["'])\s*(?:https?:)?\/\/[^"']+\1/gi)
      ];
    }
  },
  {
    ruleId: 'H5A-SAFE-002',
    message: 'Inline event-handler attributes are not allowed.',
    expected: 'No attributes whose name starts with on.',
    matches(text) {
      return [...text.matchAll(/\s(on[a-z]+)\s*=\s*(["'])[^"']*\2/gi)];
    }
  },
  {
    ruleId: 'H5A-PERF-005',
    message: 'Media must not autoplay with sound.',
    expected: 'No autoplay audio or video unless it is explicitly muted.',
    matches(text) {
      return [...text.matchAll(/<(?:audio|video)\b[^>]*\bautoplay\b[^>]*>/gi)].filter(
        (entry) => !/\bmuted\b/i.test(entry[0])
      );
    }
  }
];

function makeFinding(rule, match, text) {
  const offset = match?.index ?? 0;
  return {
    ruleId: rule.ruleId,
    offset,
    message: rule.message,
    observed: match?.[0] ?? text.slice(0, 80),
    expected: rule.expected
  };
}

export function runPreview(text) {
  const findings = [];
  for (const rule of rules) {
    if ('matches' in rule) {
      for (const match of rule.matches(text)) findings.push(makeFinding(rule, match, text));
      continue;
    }
    const match = rule.match(text);
    if (rule.fails(text, match)) findings.push(makeFinding(rule, match, text));
  }
  return findings.sort(
    (left, right) => left.offset - right.offset || left.ruleId.localeCompare(right.ruleId)
  );
}
