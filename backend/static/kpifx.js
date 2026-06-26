// 3D-наклон KPI-карточек за курсором.
(function () {
  function init() {
    const cards = document.querySelectorAll('.kpi-col .kpi-card');
    const MAX = 8; // максимальный угол наклона, градусы

    cards.forEach(card => {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;   // 0..1
        const py = (e.clientY - r.top) / r.height;    // 0..1
        const ry = (px - 0.5) * 2 * MAX;              // поворот вокруг Y
        const rx = -(py - 0.5) * 2 * MAX;             // поворот вокруг X
        card.style.transform =
          `perspective(1300px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(6px)`;
      });

      card.addEventListener('pointerleave', () => {
        card.style.transform = '';
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
