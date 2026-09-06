import { type OpenAPIV3 } from 'openapi-types';

import { EnvSet } from '#src/env-set/index.js';
import { type DeepPartial } from '#src/test-utils/tenant.js';
import { createContextWithRouteParameters } from '#src/utils/test-utils.js';

import { assembleSwaggerDocument } from './documents.js';
import { devFeatureSchemaExtension, selfHostedOnlyExtension } from './general.js';

const originalIsDevFeaturesEnabled = EnvSet.values.isDevFeaturesEnabled;
const originalIsCloud = EnvSet.values.isCloud;
const originalIsSelfHostedParityEnabled = EnvSet.values.isSelfHostedParityEnabled;

const setDevFeaturesEnabled = (isDevFeaturesEnabled: boolean) => {
  // eslint-disable-next-line @silverhand/fp/no-mutation -- Tests need to cover both dev-feature states.
  (EnvSet.values as { isDevFeaturesEnabled: boolean }).isDevFeaturesEnabled = isDevFeaturesEnabled;
};

/**
 * Mimics the generated base document: the payload schema comes from the env-free zod guards, so
 * the dev-feature property appears in `properties` and `required` without any marker — only the
 * supplement carries it, and it reaches the base property when the documents merge.
 */
const createBaseDocument = (): OpenAPIV3.Document => ({
  openapi: '3.0.1',
  info: {
    title: 'Test',
    version: '1.0.0',
  },
  paths: {
    '/api/users/{userId}': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'betaFlag'],
                  properties: {
                    id: { type: 'string' },
                    betaFlag: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const createMarkedPropertySchema = () =>
  ({
    description: 'Dev feature. The beta flag.',
    [devFeatureSchemaExtension]: true,
  }) satisfies OpenAPIV3.SchemaObject & Record<typeof devFeatureSchemaExtension, true>;

const createSupplementDocument = (): DeepPartial<OpenAPIV3.Document> => ({
  paths: {
    '/api/users/{userId}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  properties: {
                    betaFlag: createMarkedPropertySchema(),
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const assemble = () =>
  assembleSwaggerDocument(
    [createSupplementDocument()],
    createBaseDocument(),
    createContextWithRouteParameters()
  );

describe('assembleSwaggerDocument', () => {
  afterEach(() => {
    setDevFeaturesEnabled(originalIsDevFeaturesEnabled);
    Reflect.set(EnvSet.values, 'isCloud', originalIsCloud);
    Reflect.set(EnvSet.values, 'isSelfHostedParityEnabled', originalIsSelfHostedParityEnabled);
  });

  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
  ])('filters generated parity routes in Cloud=%s parity=%s', (isCloud, parity, exposed) => {
    Reflect.set(EnvSet.values, 'isCloud', isCloud);
    Reflect.set(EnvSet.values, 'isSelfHostedParityEnabled', parity);
    setDevFeaturesEnabled(false);
    const base = createBaseDocument();
    const document = assembleSwaggerDocument(
      [{ paths: { '/api/users/{userId}': { get: { tags: ['Self-hosted parity'] } } } }],
      base,
      createContextWithRouteParameters()
    );

    expect(Boolean(document.paths['/api/users/{userId}']?.get)).toBe(exposed);
    expect(base.paths['/api/users/{userId}']?.get).toBeDefined();
  });

  it('removes an unused tag when a self-hosted-only document is unavailable', () => {
    Reflect.set(EnvSet.values, 'isCloud', false);
    Reflect.set(EnvSet.values, 'isSelfHostedParityEnabled', false);
    const originalBase = createBaseDocument();
    const base: OpenAPIV3.Document = {
      ...originalBase,
      paths: {
        ...originalBase.paths,
        '/api/platform-branding': {
          get: {
            tags: ['Platform branding'],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      tags: [{ name: 'Platform branding' }],
    };
    const supplement = {
      [selfHostedOnlyExtension]: true,
      tags: [{ name: 'Platform branding', description: 'Self-hosted platform identity.' }],
      paths: { '/api/platform-branding': { get: {} } },
    } as unknown as DeepPartial<OpenAPIV3.Document>;

    const document = assembleSwaggerDocument(
      [supplement],
      base,
      createContextWithRouteParameters()
    );

    expect(document.paths['/api/platform-branding']).toBeUndefined();
    expect(document.tags).toEqual([]);
  });

  it('keeps a base tag declared by another visible supplement', () => {
    Reflect.set(EnvSet.values, 'isCloud', false);
    Reflect.set(EnvSet.values, 'isSelfHostedParityEnabled', false);
    const originalBase = createBaseDocument();
    const base: OpenAPIV3.Document = {
      ...originalBase,
      tags: [{ name: 'Organization applications' }],
    };
    const supplement: DeepPartial<OpenAPIV3.Document> = {
      tags: [
        {
          name: 'Organization applications',
          description: 'Manage application relationships for an organization.',
        },
      ],
    };

    const document = assembleSwaggerDocument(
      [supplement],
      base,
      createContextWithRouteParameters()
    );

    expect(document.tags).toEqual([
      {
        name: 'Organization applications',
        description: 'Manage application relationships for an organization.',
      },
    ]);
  });

  it('should prune dev feature properties from the assembled document when dev features are disabled', () => {
    setDevFeaturesEnabled(false);

    const document = assemble();

    expect(JSON.stringify(document)).not.toContain('betaFlag');
    expect(JSON.stringify(document)).not.toContain(devFeatureSchemaExtension);
    expect(document.paths['/api/users/{userId}']?.get?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
    });
  });

  it('should keep dev feature properties without the internal marker when dev features are enabled', () => {
    setDevFeaturesEnabled(true);

    const document = assemble();

    expect(JSON.stringify(document)).not.toContain(devFeatureSchemaExtension);
    expect(document.paths['/api/users/{userId}']?.get?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            required: ['id', 'betaFlag'],
            properties: {
              betaFlag: { description: 'Dev feature. The beta flag.' },
            },
          },
        },
      },
    });
  });
});
