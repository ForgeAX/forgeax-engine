export const profileSettingsHtml = `<!doctype html><style>
  *{box-sizing:border-box}html,body{margin:0;background:#10243a;color:#eef2fa;font:16px/22px "Reset Form"}
  main{padding:16px}h2{margin:0 0 12px}form{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}
  label{display:flex;flex-direction:column;gap:3px}input,textarea,select,button{font:inherit;min-width:0;width:100%}
  textarea{height:58px}.choice{display:block}.choice input{width:auto}button,input[type=reset]{height:34px}
  #associated{width:180px}#other{margin-top:14px}
  </style><main><h2>Profile settings</h2><form id=profile>
  <label>Display name<input id=name value=Player></label><label>Difficulty<input id=count type=number min=1 max=9 value=4></label>
  <label>Music volume<input id=volume type=range value=25></label><label>Quality<select id=quality><option value=low selected>Low</option><option value=high>High</option></select></label>
  <label>Notes<textarea id=notes>Default notes</textarea></label><label>Locked code<input id=locked disabled value=A-1></label>
  <label class=choice><input id=check type=checkbox checked> Hints</label><div><label class=choice><input id=radio-a type=radio name=mode checked> Normal</label><label class=choice><input id=radio-b type=radio name=mode> Expert</label></div>
  <button id=restore type=reset>Restore defaults</button><input id=input-reset type=reset value="Reset input">
  <label>Other form's field<input id=foreign form=other value=Foreign></label></form>
  <label>Associated outside form<input id=associated form=profile value=Outside></label>
  <form id=other><input id=unrelated value=Unrelated></form></main>`;
