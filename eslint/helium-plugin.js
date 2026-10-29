// Local ESLint rules that enforce the project structure (ADR-0004, CONVENTIONS R1–R2).
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

/**
 * Which part of `src/` a file belongs to. Paths outside `src/` (tests, scripts) return `null` and are not checked.
 * @param {string} file absolute path
 * @returns {{ layer: string, module?: string, rest: string } | null}
 */
function locate(file) {
  const rel = path.relative(SRC, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 1) return { layer: 'root', rest: rel };
  const [top, second = '', ...rest] = parts;
  if (top === 'modules') return { layer: 'modules', module: second, rest: rest.join('/') };
  return { layer: top ?? 'root', rest: [second, ...rest].join('/') };
}

/** Layers each layer may import from. A module may also import other modules, but only their `index`. */
const ALLOWED = {
  config: ['config'],
  common: ['config', 'common'],
  infrastructure: ['config', 'common', 'infrastructure'],
  modules: ['config', 'common', 'infrastructure', 'modules'],
  lambdas: ['common', 'lambdas'],
  root: ['config', 'common', 'infrastructure', 'modules', 'lambdas', 'root'],
};

/** @type {import('eslint').Rule.RuleModule} */
const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce layer and module boundaries inside src/ (ADR-0004)' },
    schema: [],
    messages: {
      layer: '"{{from}}" may not import from "{{to}}". Allowed: {{allowed}}. See ADR-0004.',
      deepImport:
        'Import module "{{target}}" only through its public API (src/modules/{{target}}/index.js), not "{{source}}". See ADR-0004.',
    },
  },
  create(context) {
    const importer = locate(context.filename);
    if (!importer) return {};

    /** @param {import('estree').Node & { source?: import('estree').Literal | null }} node */
    function check(node) {
      const source = node.source?.value;
      if (typeof source !== 'string' || !source.startsWith('.')) return;

      const target = locate(path.resolve(path.dirname(context.filename), source));
      if (!target) return;

      const allowed = ALLOWED[importer.layer] ?? [];
      if (!allowed.includes(target.layer)) {
        context.report({
          node,
          messageId: 'layer',
          data: { from: importer.layer, to: target.layer, allowed: allowed.join(', ') || 'none' },
        });
        return;
      }

      const crossesModule =
        importer.layer === 'modules' && target.layer === 'modules' && importer.module !== target.module;
      if (crossesModule && !/^index\.(js|ts)$/.test(target.rest)) {
        context.report({
          node,
          messageId: 'deepImport',
          data: { target: target.module ?? '', source },
        });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

export default {
  meta: { name: 'helium' },
  rules: { 'module-boundaries': moduleBoundaries },
};
