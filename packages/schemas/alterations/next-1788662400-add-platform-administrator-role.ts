import { generateStandardId } from '@logto/shared/universal';
import { sql } from '@silverhand/slonik';

import type { AlterationScript } from '../lib/types/alteration.js';

const alteration: AlterationScript = {
  up: async (pool) => {
    const roleId = generateStandardId();
    await pool.query(sql`
      insert into roles (tenant_id, id, name, description, type, is_default)
      values (
        'admin',
        ${roleId},
        'platformAdministrator',
        'Manage self-hosted platform settings, branding, administrators, and tenants.',
        'User',
        false
      )
      on conflict (tenant_id, name) do nothing;

      insert into users_roles (tenant_id, id, user_id, role_id)
      select
        'admin',
        substr(md5(random()::text || clock_timestamp()::text || relations.user_id), 1, 21),
        relations.user_id,
        roles.id
      from organization_role_user_relations as relations
      join roles
        on roles.tenant_id = 'admin'
        and roles.name = 'platformAdministrator'
      where relations.tenant_id = 'admin'
        and relations.organization_id = 't-default'
        and relations.organization_role_id = 'admin'
      on conflict (tenant_id, user_id, role_id) do nothing;
    `);
  },
  down: async (pool) => {
    await pool.query(sql`
      delete from roles
      where tenant_id = 'admin' and name = 'platformAdministrator';
    `);
  },
};

export default alteration;
