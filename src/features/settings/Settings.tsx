import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { PII_TYPES } from '../../core/pii/types';
import { DEFAULT_MASKING_PREFERENCES, PII_LABELS, type MaskingPreferences, type MaskingPolicy } from '../../core/pii/preferences';
import { loadMaskingPreferences, saveMaskingPreferences } from '../../shared/masking-preferences';
import { ensureAlertFonts } from '../../alert/typography';
import logoUrl from '../../alert/assets/blaind-B-light.svg';
import '../../alert/popup-theme.css';
import './settings.css';

const settingsLabels = { ...PII_LABELS, CVC: '카드 보안코드', USER_ID: '사용자 아이디' };

export function Settings() {
  const [saved, setSaved] = useState<MaskingPreferences | null>(null);
  const [draft, setDraft] = useState<MaskingPreferences>({ ...DEFAULT_MASKING_PREFERENCES });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const dirty = saved !== null && PII_TYPES.some(type => draft[type] !== saved[type]);

  async function load() {
    setBusy(true);
    try {
      const preferences = await loadMaskingPreferences();
      setSaved(preferences); setDraft(preferences); setError(false); setMessage('');
    } catch { setError(true); setMessage('설정을 불러오지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { ensureAlertFonts(document); void load(); }, []);

  function change(type: typeof PII_TYPES[number], policy: MaskingPolicy) {
    setDraft(previous => ({ ...previous, [type]: policy }));
    setMessage(''); setError(false);
  }
  async function save() {
    setBusy(true);
    try {
      await saveMaskingPreferences(draft);
      setSaved({ ...draft }); setError(false); setMessage('');
      const tab = await browser.tabs.getCurrent();
      if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
      else window.close();
    } catch { setError(true); setMessage('저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }

  return <main className="settings">
    <header className="settings-header"><img className="settings-logo" src={logoUrl} alt="블라인드" /><span>개인 설정</span></header>
    <fieldset className="label-list" disabled={busy || saved === null} aria-label="개인정보별 기본 보호 방식">
      {PII_TYPES.map(type => <div className="label-row" key={type}>
        <div className="label-name" id={`label-${type}`}>{settingsLabels[type]}</div>
        <div className="policy-switch" role="radiogroup" aria-labelledby={`label-${type}`}>
          {(['AUTO_MASK', 'CONFIRM'] as const).map(policy => <label key={policy}>
            <input type="radio" name={type} value={policy} checked={draft[type] === policy} onChange={() => change(type, policy)} />
            <span>{policy === 'AUTO_MASK' ? '필수' : '선택'}</span>
          </label>)}
        </div>
      </div>)}
    </fieldset>
    <footer className="settings-footer">
      {message && <p className={error ? 'save-status error' : 'save-status'} role={error ? 'alert' : 'status'}>{message}</p>}
      <div className="footer-actions">
        {saved === null && error ? <button className="reset" onClick={() => void load()} disabled={busy}>다시 불러오기</button> : <button className="reset" disabled={busy || saved === null} onClick={() => { setDraft({ ...DEFAULT_MASKING_PREFERENCES }); setMessage(''); setError(false); }}>기본값으로 되돌리기</button>}
        <button className="save" onClick={() => void save()} disabled={busy || !dirty}>{busy ? '처리 중…' : '설정 저장'}</button>
      </div>
    </footer>
  </main>;
}
