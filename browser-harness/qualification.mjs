const dialog = document.querySelector('#review-dialog');
const openDialog = document.querySelector('#open-dialog');
const closeDialog = document.querySelector('#close-dialog');
const recoveryValue = document.querySelector('#recovery-value');
const recoveryStatus = document.querySelector('#recovery-status');
const storageKey = 'html5assay-browser-qualification-recovery';

openDialog?.addEventListener('click', () => dialog?.showModal());
closeDialog?.addEventListener('click', () => dialog?.close());

const restored = sessionStorage.getItem(storageKey);
if (restored !== null && recoveryValue instanceof HTMLInputElement) {
  recoveryValue.value = restored;
  if (recoveryStatus !== null) recoveryStatus.textContent = `Restored ${restored}`;
}
recoveryValue?.addEventListener('input', () => {
  if (recoveryValue instanceof HTMLInputElement)
    sessionStorage.setItem(storageKey, recoveryValue.value);
});
