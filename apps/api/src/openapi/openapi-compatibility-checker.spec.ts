import { parseArgs } from './check-api-compat';
import {
  checkBackwardCompatibility,
  formatCompatibilityReport,
  type CompatibilityOptions,
} from './openapi-compatibility-checker';
import { validateOpenApiContract } from './openapi-contract-validator';

type Json = Record<string, any>;

// ─── Document builders ───────────────────────────────────────────────────────

/** A minimal document that passes every contract-validator rule. */
function doc(paths: Json, extra: Json = {}, version = '1.0.0'): Json {
  return {
    openapi: '3.0.0',
    info: { title: 'BridgeWise API', version },
    servers: [{ url: 'http://localhost:3000' }],
    tags: [{ name: 'Transactions' }],
    paths,
    ...extra,
  };
}

function op(partial: Json = {}): Json {
  return {
    operationId: 'listTransactions',
    summary: 'List transactions',
    tags: ['Transactions'],
    responses: { '200': { description: 'ok' } },
    ...partial,
  };
}

const json = (schema: Json) => ({ 'application/json': { schema } });
const ok = (schema: Json) => ({ '200': { description: 'ok', content: json(schema) } });
const body = (schema: Json, required = true) => ({ required, content: json(schema) });
const query = (name: string, schema: Json, required = false) => ({
  name,
  in: 'query',
  required,
  schema,
});
const pathParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
});

/** A document with a single GET /transactions operation. */
const withGet = (partial: Json = {}, extra: Json = {}) =>
  doc({ '/transactions': { get: op(partial) } }, extra);

/** A document with a single POST /transfers operation. */
const withPost = (partial: Json = {}, extra: Json = {}) =>
  doc(
    { '/transfers': { post: op({ operationId: 'createTransfer', ...partial }) } },
    extra,
  );

function run(base: unknown, curr: unknown, options: CompatibilityOptions = {}) {
  return checkBackwardCompatibility(base, curr, options);
}

/** `severity:rule` pairs, in discovery order. */
function rules(base: unknown, curr: unknown, options: CompatibilityOptions = {}) {
  return run(base, curr, options).changes.map((c) => `${c.severity}:${c.rule}`);
}

// Reusable schemas.
const transaction: Json = {
  type: 'object',
  properties: { id: { type: 'string' }, amount: { type: 'string' } },
  required: ['id', 'amount'],
};
const transfer: Json = {
  type: 'object',
  properties: { amount: { type: 'string' }, memo: { type: 'string' } },
  required: ['amount'],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('checkBackwardCompatibility', () => {
  describe('document handling', () => {
    it('reports no differences for identical documents', () => {
      const document = withGet();
      const report = run(document, document);

      expect(report).toMatchObject({
        compatible: true,
        changes: [],
        breakingCount: 0,
        warningCount: 0,
        infoCount: 0,
        baselineOperations: 1,
        currentOperations: 1,
        majorVersionBump: false,
      });
    });

    it('fails closed when either document is unusable', () => {
      const valid = withGet();

      expect(rules(null, valid)).toEqual(['breaking:document-invalid']);
      expect(rules(valid, 'not a document')).toEqual(['breaking:document-invalid']);
      expect(rules(valid, { openapi: '3.0.0' })).toEqual(['breaking:document-invalid']);
      expect(rules(undefined, [])).toEqual([
        'breaking:document-invalid',
        'breaking:document-invalid',
      ]);
      expect(run(null, valid).compatible).toBe(false);
    });

    it('does not let a major bump excuse an unusable document', () => {
      const report = run(null, doc({}, {}, '2.0.0'), { allowBreakingOnMajorBump: true });

      expect(report.compatible).toBe(false);
    });

    it('treats purely additive changes as compatible', () => {
      const base = doc({ '/transactions': { get: op() } });
      const curr = doc({
        '/transactions': {
          get: op(),
          post: op({ operationId: 'createTransaction' }),
        },
        '/transactions/{id}': {
          get: op({ operationId: 'getTransaction', parameters: [pathParam('id')] }),
        },
      });

      const report = run(base, curr);

      expect(report.compatible).toBe(true);
      expect(report.changes.map((c) => `${c.severity}:${c.rule}`)).toEqual([
        'info:operation-added',
        'info:operation-added',
      ]);
      expect(report.currentOperations).toBe(3);
    });
  });

  describe('operations', () => {
    it('flags a removed method as breaking', () => {
      const base = doc({
        '/transactions': { get: op(), post: op({ operationId: 'createTransaction' }) },
      });
      const curr = doc({ '/transactions': { get: op() } });

      const report = run(base, curr);

      expect(report.changes).toEqual([
        expect.objectContaining({
          rule: 'operation-removed',
          severity: 'breaking',
          location: 'paths./transactions.post',
        }),
      ]);
      expect(report.compatible).toBe(false);
    });

    it('flags a removed path as breaking', () => {
      const base = doc({
        '/transactions': { get: op() },
        '/transactions/{id}': {
          get: op({ operationId: 'getTransaction', parameters: [pathParam('id')] }),
        },
      });
      const curr = doc({ '/transactions': { get: op() } });

      const report = run(base, curr);

      expect(report.changes.map((c) => c.location)).toEqual(['paths./transactions/{id}.get']);
      expect(report.breakingCount).toBe(1);
    });

    it('requires a deprecation to be removed only when explicitly allowed', () => {
      const base = doc({
        '/transactions': {
          get: op(),
          post: op({ operationId: 'legacyCreate', deprecated: true }),
        },
      });
      const curr = doc({ '/transactions': { get: op() } });

      expect(rules(base, curr)).toEqual(['breaking:operation-removed']);
      expect(run(base, curr).compatible).toBe(false);

      const allowed = run(base, curr, { allowDeprecatedRemoval: true });
      expect(allowed.changes.map((c) => `${c.severity}:${c.rule}`)).toEqual([
        'info:deprecated-operation-removed',
      ]);
      expect(allowed.compatible).toBe(true);
    });

    it('does not excuse removing an operation that was not deprecated', () => {
      const base = doc({ '/transactions': { get: op(), post: op({ operationId: 'create' }) } });
      const curr = doc({ '/transactions': { get: op() } });

      expect(run(base, curr, { allowDeprecatedRemoval: true }).compatible).toBe(false);
    });

    it('flags a changed operationId because generated SDK methods are renamed', () => {
      expect(rules(withGet(), withGet({ operationId: 'listAll' }))).toEqual([
        'breaking:operation-id-changed',
      ]);
      expect(rules(withGet(), withGet({ operationId: undefined }))).toEqual([
        'breaking:operation-id-changed',
      ]);
    });

    it('ignores operationId when the baseline never had one', () => {
      expect(rules(withGet({ operationId: undefined }), withGet({ operationId: 'listAll' }))).toEqual(
        [],
      );
    });

    it('reports a newly deprecated operation as informational', () => {
      const report = run(withGet(), withGet({ deprecated: true }));

      expect(report.changes.map((c) => `${c.severity}:${c.rule}`)).toEqual([
        'info:operation-deprecated',
      ]);
      expect(report.compatible).toBe(true);
    });

    it('treats a renamed path parameter as the same route', () => {
      const base = doc({
        '/transactions/{id}': {
          get: op({ operationId: 'getTransaction', parameters: [pathParam('id')] }),
        },
      });
      const curr = doc({
        '/transactions/{txId}': {
          get: op({ operationId: 'getTransaction', parameters: [pathParam('txId')] }),
        },
      });

      expect(run(base, curr).changes).toEqual([]);
    });
  });

  describe('parameters', () => {
    it('flags a new required parameter as breaking and an optional one as safe', () => {
      expect(rules(withGet(), withGet({ parameters: [query('chain', { type: 'string' }, true)] }))).toEqual(
        ['breaking:required-parameter-added'],
      );
      expect(rules(withGet(), withGet({ parameters: [query('chain', { type: 'string' })] }))).toEqual([
        'info:optional-parameter-added',
      ]);
    });

    it('flags an optional parameter that became required', () => {
      const base = withGet({ parameters: [query('limit', { type: 'integer' })] });
      const curr = withGet({ parameters: [query('limit', { type: 'integer' }, true)] });

      expect(rules(base, curr)).toEqual(['breaking:parameter-became-required']);
    });

    it('warns, without failing, when a parameter is removed', () => {
      const base = withGet({ parameters: [query('limit', { type: 'integer' })] });

      const report = run(base, withGet());

      expect(report.changes.map((c) => `${c.severity}:${c.rule}`)).toEqual([
        'warning:parameter-removed',
      ]);
      expect(report.compatible).toBe(true);
    });

    it('flags a changed parameter type', () => {
      const base = withGet({ parameters: [query('limit', { type: 'integer' })] });
      const curr = withGet({ parameters: [query('limit', { type: 'string' })] });

      const [change] = run(base, curr).changes;

      expect(change).toMatchObject({
        rule: 'schema-type-changed',
        severity: 'breaking',
        location: 'paths./transactions.get.parameters.query.limit',
      });
    });

    it('allows widening integer to number for requests but not narrowing', () => {
      const integer = withGet({ parameters: [query('amount', { type: 'integer' })] });
      const number = withGet({ parameters: [query('amount', { type: 'number' })] });

      expect(rules(integer, number)).toEqual(['info:schema-type-changed']);
      expect(rules(number, integer)).toEqual(['breaking:schema-type-changed']);
    });

    it('compares request enums: removed is breaking, added is safe', () => {
      const enumOf = (values: string[]) =>
        withGet({ parameters: [query('sort', { type: 'string', enum: values })] });

      expect(rules(enumOf(['asc', 'desc', 'rank']), enumOf(['asc', 'desc']))).toEqual([
        'breaking:enum-value-removed',
      ]);
      expect(rules(enumOf(['asc']), enumOf(['asc', 'desc']))).toEqual(['info:enum-value-added']);
      expect(rules(enumOf(['asc', 'desc']), enumOf(['asc', 'desc']))).toEqual([]);
    });

    it('flags restricting a free-form request value to an enum', () => {
      const free = withGet({ parameters: [query('sort', { type: 'string' })] });
      const restricted = withGet({
        parameters: [query('sort', { type: 'string', enum: ['asc', 'desc'] })],
      });

      expect(rules(free, restricted)).toEqual(['breaking:enum-constraint-added']);
    });

    it('resolves parameters declared through $ref', () => {
      const withRef = (required: boolean) =>
        withGet(
          { parameters: [{ $ref: '#/components/parameters/Limit' }] },
          { components: { parameters: { Limit: query('limit', { type: 'integer' }, required) } } },
        );

      expect(rules(withRef(false), withRef(true))).toEqual(['breaking:parameter-became-required']);
      expect(rules(withRef(false), withRef(false))).toEqual([]);
    });

    it('honours path-level parameters', () => {
      const base = doc({
        '/transactions': { parameters: [query('limit', { type: 'integer' })], get: op() },
      });
      const curr = doc({
        '/transactions': { parameters: [query('limit', { type: 'integer' }, true)], get: op() },
      });

      expect(rules(base, curr)).toEqual(['breaking:parameter-became-required']);
    });
  });

  describe('request bodies', () => {
    it('flags a newly required body as breaking and an optional one as safe', () => {
      expect(rules(withPost(), withPost({ requestBody: body(transfer, true) }))).toEqual([
        'breaking:request-body-required-added',
      ]);
      expect(rules(withPost(), withPost({ requestBody: body(transfer, false) }))).toEqual([
        'info:request-body-added',
      ]);
    });

    it('warns when a request body is removed', () => {
      expect(rules(withPost({ requestBody: body(transfer) }), withPost())).toEqual([
        'warning:request-body-removed',
      ]);
    });

    it('flags an optional body that became required', () => {
      expect(
        rules(
          withPost({ requestBody: body(transfer, false) }),
          withPost({ requestBody: body(transfer, true) }),
        ),
      ).toEqual(['breaking:request-body-became-required']);
    });

    it('flags a dropped request media type but not an added one', () => {
      const both = {
        required: true,
        content: {
          'application/json': { schema: transfer },
          'application/x-www-form-urlencoded': { schema: transfer },
        },
      };

      expect(rules(withPost({ requestBody: both }), withPost({ requestBody: body(transfer) }))).toEqual(
        ['breaking:request-media-type-removed'],
      );
      expect(rules(withPost({ requestBody: body(transfer) }), withPost({ requestBody: both }))).toEqual(
        [],
      );
    });

    it('flags a new required property and accepts a new optional one', () => {
      const extend = (extra: Json, required: string[]) =>
        withPost({
          requestBody: body({
            ...transfer,
            properties: { ...transfer.properties, ...extra },
            required,
          }),
        });
      const base = withPost({ requestBody: body(transfer) });

      expect(rules(base, extend({ nonce: { type: 'string' } }, ['amount', 'nonce']))).toEqual([
        'breaking:request-property-required-added',
      ]);
      expect(rules(base, extend({ nonce: { type: 'string' } }, ['amount']))).toEqual([
        'info:property-added',
      ]);
    });

    it('warns when a request property is removed', () => {
      const curr = withPost({
        requestBody: body({
          type: 'object',
          properties: { amount: { type: 'string' } },
          required: ['amount'],
        }),
      });

      expect(rules(withPost({ requestBody: body(transfer) }), curr)).toEqual([
        'warning:request-property-removed',
      ]);
    });

    it('flags an optional request property that became required', () => {
      const curr = withPost({ requestBody: body({ ...transfer, required: ['amount', 'memo'] }) });

      expect(rules(withPost({ requestBody: body(transfer) }), curr)).toEqual([
        'breaking:request-property-became-required',
      ]);
    });

    it('finds type changes in nested request objects', () => {
      const nested = (rate: string) =>
        withPost({
          requestBody: body({
            type: 'object',
            properties: { fee: { type: 'object', properties: { rate: { type: rate } } } },
          }),
        });

      const [change] = run(nested('number'), nested('string')).changes;

      expect(change).toMatchObject({
        rule: 'schema-type-changed',
        severity: 'breaking',
        location: 'paths./transfers.post.requestBody.application/json.fee.rate',
      });
    });

    it('resolves schemas referenced through $ref', () => {
      const withSchema = (schema: Json) =>
        withPost(
          { requestBody: body({ $ref: '#/components/schemas/Transfer' }) },
          { components: { schemas: { Transfer: schema } } },
        );

      const [change] = run(
        withSchema(transfer),
        withSchema({
          ...transfer,
          properties: { ...transfer.properties, memo: { type: 'string' }, nonce: { type: 'string' } },
          required: ['amount', 'nonce'],
        }),
      ).changes;

      expect(change).toMatchObject({
        rule: 'request-property-required-added',
        location: 'paths./transfers.post.requestBody.application/json.nonce',
      });
    });
  });

  describe('responses', () => {
    it('flags a replaced success status as breaking', () => {
      const base = withGet({ responses: { '200': { description: 'ok' } } });
      const curr = withGet({ responses: { '201': { description: 'created' } } });

      expect(rules(base, curr)).toEqual([
        'breaking:success-response-removed',
        'info:success-response-added',
      ]);
    });

    it('only warns when an error or default response is no longer documented', () => {
      const base = withGet({
        responses: {
          '200': { description: 'ok' },
          '404': { description: 'missing' },
          default: { description: 'error' },
        },
      });

      const report = run(base, withGet());

      expect(report.changes.map((c) => `${c.severity}:${c.rule}`)).toEqual([
        'warning:response-removed',
        'warning:response-removed',
      ]);
      expect(report.compatible).toBe(true);
    });

    it('flags a dropped response media type', () => {
      const base = withGet({
        responses: {
          '200': {
            description: 'ok',
            content: { ...json(transaction), 'application/xml': { schema: transaction } },
          },
        },
      });

      expect(rules(base, withGet({ responses: ok(transaction) }))).toEqual([
        'breaking:response-media-type-removed',
      ]);
    });

    it('flags a removed response property but accepts an added one', () => {
      const withoutAmount: Json = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      };
      const withFee: Json = {
        ...transaction,
        properties: { ...transaction.properties, fee: { type: 'string' } },
      };
      const base = withGet({ responses: ok(transaction) });

      expect(rules(base, withGet({ responses: ok(withoutAmount) }))).toEqual([
        'breaking:response-property-removed',
      ]);
      expect(rules(base, withGet({ responses: ok(withFee) }))).toEqual(['info:property-added']);
    });

    it('flags a response property that may now be absent', () => {
      const curr = withGet({ responses: ok({ ...transaction, required: ['id'] }) });

      expect(rules(withGet({ responses: ok(transaction) }), curr)).toEqual([
        'breaking:response-property-became-optional',
      ]);
    });

    it('flags a changed response property type', () => {
      const curr = withGet({
        responses: ok({
          ...transaction,
          properties: { ...transaction.properties, amount: { type: 'number' } },
        }),
      });

      expect(rules(withGet({ responses: ok(transaction) }), curr)).toEqual([
        'breaking:schema-type-changed',
      ]);
    });

    it('does not treat integer to number as a safe change for responses', () => {
      const typed = (type: string) => withGet({ responses: ok({ type }) });

      expect(rules(typed('integer'), typed('number'))).toEqual(['breaking:schema-type-changed']);
    });

    it('compares response enums: a new value is a warning, a removed one is safe', () => {
      const enumOf = (values: string[]) =>
        withGet({
          responses: ok({
            type: 'object',
            properties: { status: { type: 'string', enum: values } },
          }),
        });

      expect(rules(enumOf(['pending', 'done']), enumOf(['pending', 'done', 'failed']))).toEqual([
        'warning:enum-value-added',
      ]);
      expect(rules(enumOf(['pending', 'done', 'failed']), enumOf(['pending', 'done']))).toEqual([
        'info:enum-value-removed',
      ]);
    });

    it('descends into array items', () => {
      const list = (item: Json) => withGet({ responses: ok({ type: 'array', items: item }) });
      const itemWithoutAmount: Json = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      };

      const [change] = run(list(transaction), list(itemWithoutAmount)).changes;

      expect(change).toMatchObject({
        rule: 'response-property-removed',
        location: 'paths./transactions.get.responses.200.application/json[].amount',
      });
    });

    it('flattens allOf composition before comparing', () => {
      const composed = (extra: Json) =>
        withGet(
          {
            responses: ok({
              allOf: [{ $ref: '#/components/schemas/Base' }, extra],
            }),
          },
          {
            components: {
              schemas: {
                Base: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
              },
            },
          },
        );
      const withAmount: Json = {
        type: 'object',
        properties: { amount: { type: 'string' } },
        required: ['amount'],
      };

      expect(rules(composed(withAmount), composed({ type: 'object', properties: {} }))).toEqual([
        'breaking:response-property-removed',
      ]);
      expect(rules(composed(withAmount), composed(withAmount))).toEqual([]);
    });

    it('terminates on recursive schemas and still reports changes inside them', () => {
      const tree = (properties: Json) => ({
        components: {
          schemas: {
            Node: {
              type: 'object',
              properties: {
                ...properties,
                children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
              },
            },
          },
        },
      });
      const build = (properties: Json) =>
        withGet({ responses: ok({ $ref: '#/components/schemas/Node' }) }, tree(properties));

      expect(rules(build({ name: { type: 'string' } }), build({ name: { type: 'string' } }))).toEqual(
        [],
      );
      expect(rules(build({ name: { type: 'string' } }), build({}))).toEqual([
        'breaking:response-property-removed',
      ]);
    });

    it('reports a shared schema change at every place it is used', () => {
      const shared = (schema: Json) =>
        doc(
          {
            '/transactions': {
              get: op({ responses: ok({ $ref: '#/components/schemas/Transaction' }) }),
            },
            '/transactions/latest': {
              get: op({
                operationId: 'latestTransaction',
                responses: ok({ $ref: '#/components/schemas/Transaction' }),
              }),
            },
          },
          { components: { schemas: { Transaction: schema } } },
        );
      const withoutAmount: Json = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      };

      const report = run(shared(transaction), shared(withoutAmount));

      expect(report.changes.map((c) => c.location)).toEqual([
        'paths./transactions.get.responses.200.application/json.amount',
        'paths./transactions/latest.get.responses.200.application/json.amount',
      ]);
    });
  });

  describe('security', () => {
    const bearer = [{ bearer: [] }];

    it('flags an operation that now requires authentication', () => {
      expect(rules(withGet(), withGet({ security: bearer }))).toEqual([
        'breaking:authentication-added',
      ]);
    });

    it('inherits document-level security', () => {
      expect(rules(withGet(), withGet({}, { security: bearer }))).toEqual([
        'breaking:authentication-added',
      ]);
    });

    it('does not flag operations that were already authenticated', () => {
      expect(rules(withGet({ security: bearer }), withGet({ security: bearer }))).toEqual([]);
    });

    it('does not treat an anonymous alternative as a requirement', () => {
      expect(rules(withGet(), withGet({ security: [{ bearer: [] }, {}] }))).toEqual([]);
    });

    it('does not flag removing authentication', () => {
      expect(rules(withGet({ security: bearer }), withGet())).toEqual([]);
    });
  });

  describe('options', () => {
    const base = doc({ '/transactions': { get: op(), post: op({ operationId: 'create' }) } });
    const breakingCurrent = (version: string) => doc({ '/transactions': { get: op() } }, {}, version);

    it('accepts breaking changes under a major bump only when asked to', () => {
      const report = run(base, breakingCurrent('2.0.0'));
      expect(report).toMatchObject({ majorVersionBump: true, breakingCount: 1, compatible: false });

      expect(run(base, breakingCurrent('2.0.0'), { allowBreakingOnMajorBump: true })).toMatchObject({
        breakingCount: 1,
        compatible: true,
      });
    });

    it('does not accept breaking changes without a major bump', () => {
      const options = { allowBreakingOnMajorBump: true };

      expect(run(base, breakingCurrent('1.1.0'), options).compatible).toBe(false);
      expect(run(base, breakingCurrent('1.0.0'), options).compatible).toBe(false);
      expect(run(doc({ '/transactions': { get: op(), post: op({ operationId: 'c' }) } }, {}, '2.0.0'), breakingCurrent('1.0.0'), options).compatible).toBe(false);
    });

    it('understands v-prefixed and unparsable versions', () => {
      const versioned = (version: unknown) =>
        run(
          doc({ '/transactions': { get: op() } }, {}, 'v1.4'),
          { ...breakingCurrent('x'), info: { title: 't', version } },
        ).majorVersionBump;

      expect(versioned('v2.0')).toBe(true);
      expect(versioned('v1.9')).toBe(false);
      expect(versioned('latest')).toBe(false);
      expect(versioned(undefined)).toBe(false);
    });

    it('can treat warnings as failures', () => {
      const withParam = withGet({ parameters: [query('limit', { type: 'integer' })] });

      expect(run(withParam, withGet()).compatible).toBe(true);
      expect(run(withParam, withGet(), { strictWarnings: true })).toMatchObject({
        warningCount: 1,
        compatible: false,
      });
    });
  });

  describe('integration with the contract validator', () => {
    const list = (extra: Json = {}, item: Json = transaction) =>
      op({
        operationId: 'listTransactions',
        parameters: [query('limit', { type: 'integer' })],
        responses: ok({ type: 'array', items: item }),
        ...extra,
      });
    const get = (item: Json = transaction) =>
      op({ operationId: 'getTransaction', parameters: [pathParam('id')], responses: ok(item) });

    const v1 = doc({ '/transactions': { get: list() }, '/transactions/{id}': { get: get() } });

    const transactionWithFee: Json = {
      ...transaction,
      properties: { ...transaction.properties, fee: { type: 'string' } },
    };
    const v1_1 = doc(
      {
        '/transactions': {
          get: list(
            { parameters: [query('limit', { type: 'integer' }), query('status', { type: 'string' })] },
            transactionWithFee,
          ),
          post: op({
            operationId: 'createTransaction',
            requestBody: body(transfer),
            responses: { '201': { description: 'created' } },
          }),
        },
        '/transactions/{id}': { get: get(transactionWithFee) },
      },
      {},
      '1.1.0',
    );

    const v2 = doc(
      {
        '/transactions': {
          get: list({
            operationId: 'getTransactions',
            parameters: [query('limit', { type: 'integer' }, true)],
          }),
        },
      },
      {},
      '2.0.0',
    );

    it('uses fixtures that are each valid contracts', () => {
      for (const document of [v1, v1_1, v2]) {
        expect(validateOpenApiContract(document).valid).toBe(true);
      }
    });

    it('accepts an additive minor release', () => {
      const report = run(v1, v1_1);

      expect(report).toMatchObject({
        compatible: true,
        breakingCount: 0,
        warningCount: 0,
        infoCount: 4,
        majorVersionBump: false,
      });
    });

    it('rejects a breaking release, and only accepts it as a deliberate major bump', () => {
      const report = run(v1, v2);

      expect(report.changes.map((c) => c.rule).sort()).toEqual([
        'operation-id-changed',
        'operation-removed',
        'parameter-became-required',
      ]);
      expect(report).toMatchObject({ compatible: false, breakingCount: 3, majorVersionBump: true });
      expect(run(v1, v2, { allowBreakingOnMajorBump: true }).compatible).toBe(true);
    });

    it('is not symmetric: undoing an additive change is breaking', () => {
      const report = run(v1_1, v1);

      expect(report.compatible).toBe(false);
      expect(report.changes.map((c) => c.rule)).toContain('operation-removed');
    });
  });
});

describe('formatCompatibilityReport', () => {
  it('states when there are no differences', () => {
    const document = withGet();

    expect(formatCompatibilityReport(run(document, document))).toContain('No differences.');
  });

  it('lists breaking changes first and points to the major-bump escape hatch', () => {
    const base = doc({ '/transactions': { get: op(), post: op({ operationId: 'create' }) } });
    const curr = doc({
      '/transactions': { get: op(), put: op({ operationId: 'replace' }) },
    });

    const output = formatCompatibilityReport(run(base, curr));

    expect(output).toContain('INCOMPATIBLE');
    expect(output).toContain('[operation-removed] paths./transactions.post');
    expect(output).toContain('Tip: breaking changes are only accepted with a major version bump');
    expect(output.indexOf('BREAKING:')).toBeLessThan(output.indexOf('INFO:'));
  });

  it('reports a compatible verdict without the tip', () => {
    const output = formatCompatibilityReport(
      run(withGet(), doc({ '/transactions': { get: op(), post: op({ operationId: 'create' }) } })),
    );

    expect(output).toContain('API compatibility: COMPATIBLE');
    expect(output).not.toContain('Tip:');
  });
});

describe('check-api-compat parseArgs', () => {
  it('reads positional paths and flags', () => {
    expect(
      parseArgs(['base.json', 'curr.json', '--allow-major-bump', '--strict', '--allow-deprecated-removal']),
    ).toEqual({
      baselinePath: 'base.json',
      currentPath: 'curr.json',
      options: {
        allowBreakingOnMajorBump: true,
        strictWarnings: true,
        allowDeprecatedRemoval: true,
      },
      unknownFlags: [],
    });
  });

  it('collects unknown flags and tolerates missing paths', () => {
    expect(parseArgs(['--bogus', 'only-one.json'])).toEqual({
      baselinePath: 'only-one.json',
      currentPath: undefined,
      options: {},
      unknownFlags: ['--bogus'],
    });
  });
});
