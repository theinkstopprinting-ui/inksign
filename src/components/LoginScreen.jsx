import React, { useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// "Who's using InkSign?" — shown when sign-in is turned on in Settings.
export default function LoginScreen({ users, onIn }) {
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    try { onIn(await api.users.login(who.id, pin)); } catch (e) { setErr(clean(e.message)); setPin(''); }
  };
  return (
    <div className="login">
      <div className="login-box">
        <div className="brand"><span className="logo">◆</span> InkSign</div>
        {!who ? (<>
          <p className="muted">Who's using InkSign?</p>
          <div className="login-users">{users.map((u) => <button key={u.id} className="btn" onClick={() => setWho(u)}>{u.name}<small>{u.role}</small></button>)}</div>
        </>) : (<>
          <p>Hi {who.name} — your PIN:</p>
          <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} onKeyDown={(e) => e.key === 'Enter' && go()} />
          <div className="row"><button className="btn ghost" onClick={() => { setWho(null); setPin(''); }}>Back</button><button className="btn primary" onClick={go}>Sign in</button></div>
          {err && <div className="error">{err}</div>}
        </>)}
      </div>
    </div>
  );
}
