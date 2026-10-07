const defaults = ['user-select', '-webkit-user-select', 'display', 'visibility', 'pointer-events', 'overflow-y'];

function describe(element) {
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), id: element.id, classes: [...element.classList],
        attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value.slice(0, 500)])),
        text: (element.textContent || '').trim().slice(0, 1000),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
}

function ancestors(element) {
    const chain = [];
    for (let node = element; node && chain.length < 16; node = node.parentElement) chain.push(node);
    return chain;
}

function query({ selector, limit = 20 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
    const elements = document.querySelectorAll(selector);
    return { count: elements.length, elements: [...elements].slice(0, limit) };
}

export function start(ctx) {
    const inspector = {
        inspect(parameters) {
            const { count, elements } = query(parameters);
            return { count, elements: elements.map(element => ({ ...describe(element),
                ancestors: ancestors(element).map(node => ({ ...describe(node),
                    styles: Object.fromEntries(defaults.map(property => [property, getComputedStyle(node).getPropertyValue(property)])) })) })) };
        },
        styles(parameters) {
            const { count, elements } = query(parameters);
            const properties = parameters.properties || defaults;
            if (!Array.isArray(properties) || properties.length > 30 || properties.some(property => typeof property !== 'string' || property.length > 100))
                throw new Error('Provide up to 30 CSS property names');
            const inaccessible = new Set();
            let visited = 0;
            const candidates = [];
            function collectRules(rules, source) {
                for (const rule of rules) {
                    if (++visited > 100000) return;
                    if (rule.selectorText && rule.style) {
                        const declarations = Object.fromEntries(properties.filter(property => rule.style.getPropertyValue(property)).map(property =>
                            [property, { value: rule.style.getPropertyValue(property), important: rule.style.getPropertyPriority(property) === 'important' }]));
                        if (Object.keys(declarations).length) candidates.push({ selector: rule.selectorText, source, declarations });
                    } else if (rule.cssRules) {
                        if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
                        if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
                        collectRules(rule.cssRules, source);
                    }
                }
            }
            for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
                if (sheet.disabled || (sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches)) continue;
                try { collectRules(sheet.cssRules, sheet.href || '<inline stylesheet>'); }
                catch { inaccessible.add(sheet.href || '<inline stylesheet>'); }
            }
            let truncated = visited > 100000;
            const result = elements.map(element => ({ ...describe(element), ancestors: ancestors(element).map(node => {
                const rules = [];
                for (const candidate of candidates) {
                    try {
                        if (!node.matches(candidate.selector)) continue;
                        if (rules.length >= 100) { truncated = true; break; }
                        rules.push(candidate);
                    } catch {}
                }
                return { ...describe(node), computed: Object.fromEntries(properties.map(property => [property, getComputedStyle(node).getPropertyValue(property)])),
                    inline: Object.fromEntries(properties.filter(property => node.style.getPropertyValue(property)).map(property => [property, node.style.getPropertyValue(property)])),
                    matchingRules: rules };
            }) }));
            return { count, elements: result, inaccessibleStylesheets: [...inaccessible], truncated };
        }
    };
    Object.defineProperty(window, 'BedrockInspector', { value: inspector, configurable: true });
    ctx.cleanup(() => { if (window.BedrockInspector === inspector) delete window.BedrockInspector; });
}
