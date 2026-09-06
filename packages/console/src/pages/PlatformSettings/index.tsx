import { Image, ShieldCheck, Trash2, Upload, UserPlus } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import PageMeta from '@/components/PageMeta';
import CardTitle from '@/ds-components/CardTitle';
import Switch from '@/ds-components/Switch';
import TextInput from '@/ds-components/TextInput';
import {
  type PlatformAdministrator,
  type PlatformBranding,
  usePlatformAccess,
  usePlatformApi,
} from '@/hooks/use-platform-api';
import NotFound from '@/pages/NotFound';

import styles from './index.module.scss';

const acceptedLogoTypes = 'image/png,image/jpeg,image/svg+xml';

const getAdministratorLabel = (administrator: PlatformAdministrator) =>
  administrator.name ?? administrator.username ?? administrator.primaryEmail ?? administrator.id;

function PlatformSettings() {
  const { t } = useTranslation(undefined, { keyPrefix: 'admin_console.platform' });
  const request = usePlatformApi();
  const { isLoading: isAccessLoading, isPlatformAdministrator } = usePlatformAccess();
  const { data: branding, mutate: mutateBranding } = useSWR<PlatformBranding>(
    isPlatformAdministrator ? '/api/instance/branding' : null,
    async (path: string) => request<PlatformBranding>(path)
  );
  const { data: administrators, mutate: mutateAdministrators } = useSWR<PlatformAdministrator[]>(
    isPlatformAdministrator ? '/api/instance/platform-administrators' : null,
    async (path: string) => request<PlatformAdministrator[]>(path)
  );
  const [form, setForm] = useState<PlatformBranding>();
  const [identifier, setIdentifier] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [uploadingVariant, setUploadingVariant] = useState<'light' | 'dark'>();

  useEffect(() => {
    if (branding) {
      setForm(branding);
    }
  }, [branding]);

  if (!isAccessLoading && !isPlatformAdministrator) {
    return <NotFound />;
  }

  const updateField = <Key extends keyof PlatformBranding>(
    key: Key,
    value: PlatformBranding[Key]
  ) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const submitBranding = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      const updated = await request<PlatformBranding>('/api/instance/branding', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      await mutateBranding(updated, false);
      toast.success(t('saved'));
      window.location.reload();
    } catch {
      // The shared platform request helper already displays the localized server error.
    } finally {
      setIsSaving(false);
    }
  };

  const uploadLogo = async (variant: 'light' | 'dark', event: ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? []);
    // eslint-disable-next-line @silverhand/fp/no-mutation -- Reset the picker so the same logo file can be selected again.
    event.target.value = '';
    if (!file) {
      return;
    }
    setUploadingVariant(variant);
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await request<{ branding: PlatformBranding }>(
        `/api/instance/branding/logo/${variant}`,
        { method: 'POST', body }
      );
      setForm(result.branding);
      await mutateBranding(result.branding, false);
      toast.success(t('logo_uploaded'));
    } catch {
      // The shared platform request helper already displays the localized server error.
    } finally {
      setUploadingVariant(undefined);
    }
  };

  const addAdministrator = async (event: FormEvent) => {
    event.preventDefault();
    if (!identifier.trim()) {
      return;
    }
    try {
      await request('/api/instance/platform-administrators', {
        method: 'POST',
        body: JSON.stringify({ identifier }),
      });
      setIdentifier('');
      await mutateAdministrators();
      toast.success(t('administrator_added'));
    } catch {
      // The shared platform request helper already displays the localized server error.
    }
  };

  return (
    <div className={styles.page}>
      <PageMeta titleKey="platform.title" />
      <CardTitle title="platform.title" subtitle="platform.subtitle" />

      <section className={styles.card}>
        <div className={styles.sectionTitle}>
          <Image />
          <div>
            <h2>{t('branding_title')}</h2>
            <p>{t('branding_description')}</p>
          </div>
        </div>
        {form && (
          <form className={styles.form} onSubmit={submitBranding}>
            <label>
              <span>{t('product_name')}</span>
              <TextInput
                required
                maxLength={64}
                value={form.productName}
                onChange={(event) => {
                  updateField('productName', event.currentTarget.value);
                }}
              />
            </label>
            <label>
              <span>{t('slogan')}</span>
              <TextInput
                maxLength={160}
                value={form.slogan}
                onChange={(event) => {
                  updateField('slogan', event.currentTarget.value);
                }}
              />
            </label>
            <div className={styles.logoGrid}>
              {(['light', 'dark'] as const).map((variant) => {
                const url = variant === 'light' ? form.logoUrl : form.darkLogoUrl;
                return (
                  <div key={variant} className={styles.logoCard} data-theme={variant}>
                    <span>{t(variant === 'light' ? 'light_logo' : 'dark_logo')}</span>
                    <div className={styles.logoPreview}>
                      {url ? <img alt="" src={url} /> : <Image />}
                      <strong>{form.productName}</strong>
                    </div>
                    <label className={styles.uploadButton}>
                      <Upload />
                      {uploadingVariant === variant ? t('uploading') : t('upload_logo')}
                      <input
                        accept={acceptedLogoTypes}
                        disabled={Boolean(uploadingVariant)}
                        type="file"
                        onChange={async (event) => uploadLogo(variant, event)}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
            <div className={styles.noticeSetting}>
              <div className={styles.administratorMeta}>
                <strong>{t('hide_open_source_notice')}</strong>
                <p>{t('hide_open_source_notice_description')}</p>
              </div>
              <Switch
                checked={form.hideOpenSourceNotice}
                onChange={(event) => {
                  updateField('hideOpenSourceNotice', event.currentTarget.checked);
                }}
              />
            </div>
            <button className={styles.primaryButton} disabled={isSaving} type="submit">
              {isSaving ? t('saving') : t('save')}
            </button>
          </form>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}>
          <ShieldCheck />
          <div>
            <h2>{t('administrators_title')}</h2>
            <p>{t('administrators_description')}</p>
          </div>
        </div>
        <form className={styles.addAdministrator} onSubmit={addAdministrator}>
          <TextInput
            placeholder={t('administrator_identifier_placeholder')}
            value={identifier}
            onChange={(event) => {
              setIdentifier(event.currentTarget.value);
            }}
          />
          <button className={styles.secondaryButton} type="submit">
            <UserPlus />
            {t('add_administrator')}
          </button>
        </form>
        <div className={styles.administratorList}>
          {administrators?.map((administrator) => (
            <div key={administrator.id} className={styles.administratorRow}>
              <div>
                <strong>{getAdministratorLabel(administrator)}</strong>
                <span className={styles.administratorEmail}>
                  {administrator.primaryEmail ?? administrator.id}
                </span>
              </div>
              <button
                aria-label={t('remove_administrator')}
                className={styles.iconButton}
                type="button"
                onClick={async () => {
                  try {
                    await request(`/api/instance/platform-administrators/${administrator.id}`, {
                      method: 'DELETE',
                    });
                    await mutateAdministrators();
                  } catch {
                    // The shared platform request helper already displays the localized server error.
                  }
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default PlatformSettings;
