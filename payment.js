// Static QR payment UI module
// Safe rule: never credit wallet from the amount typed by the user.
// Wallet credit must follow verified payment/reconciliation.
async function openStaticQRPayment(){
  const cfg=await api("/api/payment-settings");
  if(cfg.error) return toast(cfg.error);
  const amount=Number(prompt("Enter amount ₹"));
  if(!Number.isFinite(amount)||amount<=0) return;
  if(amount<Number(cfg.minAmount||10)||amount>Number(cfg.maxAmount||10000))
    return toast("Amount outside allowed range");
  if(!cfg.qrImageUrl) return toast("Admin has not uploaded a payment QR");
  const r=await api("/api/payment-intent","POST",{userId:me.id,amount});
  if(r.error) return toast(r.error);
  document.body.insertAdjacentHTML("beforeend",
    `<div class="modal"><div class="modalbox">
      <button class="close" onclick="closeModal()">×</button>
      <div class="tag">SCAN & PAY</div><h2>Pay ₹${r.amount}</h2>
      <img class="payQR" src="${r.qrImageUrl}">
      <p class="muted">After paying, wait for verified payment confirmation.</p>
      <button class="join" onclick="checkStaticQRPayment('${r.intentId}')">CHECK PAYMENT</button>
      <div id="payStatus" class="selected">Waiting for verification…</div>
    </div></div>`);
}
async function checkStaticQRPayment(id){
  const r=await api("/api/payment-intent/"+id);
  if(r.error) return toast(r.error);
  $("#payStatus").textContent=r.status==="VERIFIED"
    ? "Payment Received ₹"+r.receivedAmount+" ✅"
    : "Payment is not verified yet.";
}
