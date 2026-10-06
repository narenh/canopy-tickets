// Framing a profile photo: shows the picked file full screen with a fixed
// circle, pinch/drag to fit (Cropper.js 1.x, vendored in /vendor), and
// resolves with the framed part as a 512px square JPEG -- or null if the
// person cancels.
//
// What leaves the phone is that square, drawn fresh by the browser: not
// the original, and without its EXIF (location included).
//
// Used by the welcome page (setting up a profile) and the reservation
// page (changing the photo later). Brings its own markup and styles;
// needs cropper.min.js loaded first.
(function(){
  const CSS_HREF = '/vendor/cropperjs-1.6.3/cropper.min.css';

  function ensureStyles(){
    if (document.getElementById('photoCropStyles')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    document.head.appendChild(link);
    const style = document.createElement('style');
    style.id = 'photoCropStyles';
    style.textContent = [
      '.pc-overlay{position:fixed;inset:0;z-index:200;background:#000;display:flex;flex-direction:column;',
      'padding:calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));',
      'font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}',
      '.pc-hint{color:#ccc;font-size:13px;text-align:center;margin:6px 0 12px;}',
      '.pc-stage{flex:1;min-height:0;}',
      '.pc-stage img{display:block;max-width:100%;}',
      '.pc-overlay .cropper-view-box,.pc-overlay .cropper-face{border-radius:50%;}',
      '.pc-overlay .cropper-view-box{outline:2px solid rgba(255,255,255,.85);outline-offset:-2px;}',
      '.pc-actions{display:flex;gap:10px;margin-top:14px;}',
      '.pc-actions button{flex:1;border:none;border-radius:12px;padding:12px;font-size:15px;font-weight:700;cursor:pointer;}',
      '.pc-cancel{background:#1e1e1e;color:#fff;border:1px solid #3a3a3a !important;}',
      '.pc-use{background:#c9a24b;color:#241c07;}'
    ].join('');
    document.head.appendChild(style);
  }

  // `hint` is the line above the photo. Rejects if the file can't be read
  // as an image (some formats a browser can't open).
  window.cropProfilePhoto = function(file, hint){
    ensureStyles();
    return new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.className = 'pc-overlay';
      overlay.innerHTML =
        '<div class="pc-hint"></div>' +
        '<div class="pc-stage"><img alt=""></div>' +
        '<div class="pc-actions"><button type="button" class="pc-cancel">Cancel</button>' +
        '<button type="button" class="pc-use">Use photo</button></div>';
      overlay.querySelector('.pc-hint').textContent = hint || '';
      document.body.appendChild(overlay);

      const url = URL.createObjectURL(file);
      const img = overlay.querySelector('img');
      let cropper = null;
      const done = (value, error) => {
        if (cropper) cropper.destroy();
        URL.revokeObjectURL(url);
        overlay.remove();
        if (error) reject(error); else resolve(value);
      };

      img.onerror = () => done(null, new Error('unreadable image'));
      img.onload = () => {
        cropper = new Cropper(img, {
          aspectRatio: 1,
          viewMode: 1,
          dragMode: 'move',
          autoCropArea: 0.9,
          cropBoxMovable: false,
          cropBoxResizable: false,
          toggleDragModeOnDblclick: false,
          guides: false,
          center: false,
          highlight: false,
          background: false
        });
      };
      img.src = url;

      overlay.querySelector('.pc-cancel').addEventListener('click', () => done(null));
      overlay.querySelector('.pc-use').addEventListener('click', () => {
        if (!cropper) return;
        const canvas = cropper.getCroppedCanvas({ width: 512, height: 512, fillColor: '#000', imageSmoothingQuality: 'high' });
        if (!canvas){ done(null, new Error('crop failed')); return; }
        canvas.toBlob((blob) => {
          if (!blob){ done(null, new Error('crop failed')); return; }
          done({ blob, dataUrl: canvas.toDataURL('image/jpeg', 0.8) });
        }, 'image/jpeg', 0.88);
      });
    });
  };
})();
