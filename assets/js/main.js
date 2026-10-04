/* ==========================================================================
   Jagirdar Publications — interactions
   ========================================================================== */
(() => {
    'use strict';

    const $ = (s, root = document) => root.querySelector(s);
    const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const lerp = (a, b, t) => a + (b - a) * t;

    const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? (location.port === '5000' ? '' : 'http://localhost:5000')
        : (location.hostname.includes('vercel.app') ? '' : 'https://jagirdar.vercel.app');
    const WA_NUMBER = '919904499394';
    const DEFAULT_PRICE = 399;

    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    };

    /* ---------- Smooth scroll (Lenis) ---------- */
    let lenis = null;
    const initLenis = () => {
        if (reduceMotion || typeof window.Lenis !== 'function') return;
        lenis = new window.Lenis({ duration: 1.15, easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true });
        const raf = (time) => { lenis.raf(time); requestAnimationFrame(raf); };
        requestAnimationFrame(raf);
    };

    const scrollToTarget = (target) => {
        if (lenis) lenis.scrollTo(target, { offset: target === 0 ? 0 : -90 });
        else if (target === 0) window.scrollTo({ top: 0, behavior: 'smooth' });
        else target.scrollIntoView({ behavior: 'smooth' });
    };

    const initAnchors = () => {
        document.addEventListener('click', (e) => {
            const a = e.target.closest('a[href^="#"]');
            if (!a) return;
            const id = a.getAttribute('href');
            if (id === '#') return;
            const target = id === '#home' ? 0 : $(id);
            if (target === null) return;
            e.preventDefault();
            closeMenu();
            scrollToTarget(target);
            history.replaceState(null, '', id === '#home' ? location.pathname : id);
        });
    };

    /* ---------- Header / menu / progress ---------- */
    const header = $('#header');
    const menuBtn = $('#menu-btn');
    const mobileMenu = $('#mobile-menu');
    const progress = $('.scroll-progress');

    function closeMenu() {
        if (!mobileMenu || mobileMenu.hidden) return;
        mobileMenu.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
    }

    const initHeader = () => {
        if (menuBtn && mobileMenu) {
            menuBtn.addEventListener('click', () => {
                const open = mobileMenu.hidden;
                mobileMenu.hidden = !open;
                menuBtn.setAttribute('aria-expanded', String(open));
            });
            $$('a', mobileMenu).forEach(a => a.addEventListener('click', closeMenu));
        }

        let lastY = window.scrollY;
        const onScroll = () => {
            const y = window.scrollY;
            if (header) {
                header.classList.toggle('is-scrolled', y > 30);
                const goingDown = y > lastY + 4;
                const goingUp = y < lastY - 4;
                if (goingDown && y > 500 && (!mobileMenu || mobileMenu.hidden)) header.classList.add('is-hidden');
                else if (goingUp || y < 200) header.classList.remove('is-hidden');
            }
            if (progress) {
                const max = document.documentElement.scrollHeight - window.innerHeight;
                progress.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
            }
            lastY = y;
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();

        // Active nav link
        const links = $$('.nav-links a[href^="#"]');
        const sections = links.map(l => $(l.getAttribute('href'))).filter(Boolean);
        if (sections.length) {
            const io = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    links.forEach(l => l.classList.toggle('is-active', l.getAttribute('href') === '#' + entry.target.id));
                });
            }, { rootMargin: '-45% 0px -50% 0px' });
            sections.forEach(s => io.observe(s));
        }
    };

    /* ---------- Split words + reveal ---------- */
    const initReveal = () => {
        $$('[data-split]').forEach(el => {
            const words = el.textContent.trim().split(/\s+/);
            const base = parseInt(el.closest('.split-words')?.dataset.base || '0', 10);
            el.textContent = '';
            words.forEach((word, i) => {
                const w = document.createElement('span');
                w.className = 'w';
                const inner = document.createElement('span');
                inner.textContent = word;
                inner.style.setProperty('--i', base + i);
                w.appendChild(inner);
                el.appendChild(w);
                if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
            });
        });
        // Second line of hero title continues the stagger
        const heroTitle = $('.hero-title');
        if (heroTitle) {
            let i = 0;
            $$('.w > span', heroTitle).forEach(s => s.style.setProperty('--i', i++ + 2));
        }

        const targets = $$('.reveal, .split-words');
        if (reduceMotion || !('IntersectionObserver' in window)) {
            targets.forEach(t => t.classList.add('is-visible'));
            return;
        }
        const io = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    io.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
        targets.forEach(t => io.observe(t));
    };

    /* ---------- Parallax + mouse depth ---------- */
    const initParallax = () => {
        if (reduceMotion) return;
        const items = $$('[data-parallax], [data-depth]').map(el => ({
            el,
            speed: parseFloat(el.dataset.parallax || '0'),
            depth: parseFloat(el.dataset.depth || '0'),
        }));
        const aboutFrame = $('#about-frame');
        const aboutImg = aboutFrame ? $('img', aboutFrame) : null;
        const tilt = $('#book-tilt');
        const hero = $('#hero');
        const bookFront = $('.book-front');

        const mouse = { x: 0, y: 0, cx: 0, cy: 0 };
        if (finePointer) {
            window.addEventListener('pointermove', e => {
                mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
                mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
            }, { passive: true });
        }

        const vh = () => window.innerHeight;
        const tick = () => {
            mouse.cx = lerp(mouse.cx, mouse.x, 0.06);
            mouse.cy = lerp(mouse.cy, mouse.y, 0.06);
            const h = vh();
            const heroVisible = hero ? hero.getBoundingClientRect().bottom > 0 : false;

            for (const it of items) {
                const r = it.el.getBoundingClientRect();
                if (r.bottom < -200 || r.top > h + 200) continue;
                const center = r.top + r.height / 2 - h / 2;
                const py = it.speed ? -center * it.speed : 0;
                const dx = it.depth && heroVisible ? mouse.cx * it.depth : 0;
                const dy = it.depth && heroVisible ? mouse.cy * it.depth : 0;
                it.el.style.translate = `${dx.toFixed(2)}px ${(py + dy).toFixed(2)}px`;
            }

            if (aboutImg) {
                const r = aboutFrame.getBoundingClientRect();
                if (r.bottom > 0 && r.top < h) {
                    const p = (r.top + r.height) / (h + r.height); // 1 → 0 as it scrolls through
                    aboutImg.style.transform = `translateY(${(-13 * (1 - p)).toFixed(2)}%)`;
                }
            }

            if (tilt && heroVisible) {
                tilt.style.transform = `rotateY(${(mouse.cx * 14).toFixed(2)}deg) rotateX(${(-mouse.cy * 9).toFixed(2)}deg)`;
                if (bookFront) bookFront.style.setProperty('--sheen', `${(mouse.cx * 60).toFixed(1)}%`);
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    /* ---------- Mandalas ---------- */
    const initMandala = () => {
        const ns = 'http://www.w3.org/2000/svg';
        $$('svg.mandala').forEach(svg => {
            if (svg.childElementCount) return;
            const g = document.createElementNS(ns, 'g');
            g.setAttribute('fill', 'none');
            g.setAttribute('stroke', 'rgba(246,231,193,0.55)');
            g.setAttribute('stroke-width', '0.8');
            const petal = (r1, r2, w, n, rot = 0) => {
                for (let i = 0; i < n; i++) {
                    const p = document.createElementNS(ns, 'path');
                    p.setAttribute('d', `M200 ${200 - r1} Q ${200 + w} ${200 - (r1 + r2) / 2} 200 ${200 - r2} Q ${200 - w} ${200 - (r1 + r2) / 2} 200 ${200 - r1} Z`);
                    p.setAttribute('transform', `rotate(${(360 / n) * i + rot} 200 200)`);
                    g.appendChild(p);
                }
            };
            petal(70, 112, 12, 16);
            petal(118, 168, 14, 24);
            petal(150, 192, 9, 48, 3.75);
            [66, 116, 172, 196].forEach(r => {
                const c = document.createElementNS(ns, 'circle');
                c.setAttribute('cx', 200); c.setAttribute('cy', 200); c.setAttribute('r', r);
                g.appendChild(c);
            });
            for (let i = 0; i < 36; i++) {
                const d = document.createElementNS(ns, 'circle');
                const ang = (i / 36) * Math.PI * 2;
                d.setAttribute('cx', 200 + Math.cos(ang) * 184); d.setAttribute('cy', 200 + Math.sin(ang) * 184);
                d.setAttribute('r', 1.6); d.setAttribute('fill', 'rgba(246,231,193,0.6)'); d.setAttribute('stroke', 'none');
                g.appendChild(d);
            }
            svg.appendChild(g);
        });
    };

    /* ---------- Divine dust (page-wide) ---------- */
    const initParticles = () => {
        const canvas = $('#dust');
        if (!canvas || reduceMotion) return;
        const ctx = canvas.getContext('2d');
        let w, h, dpr, parts = [];
        const count = window.innerWidth < 640 ? 30 : 70;

        const resize = () => {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            w = window.innerWidth; h = window.innerHeight;
            canvas.width = w * dpr; canvas.height = h * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        const spawn = (init) => ({
            x: Math.random() * w,
            y: init ? Math.random() * h : h + 10,
            r: Math.random() * 1.6 + 0.4,
            vy: Math.random() * 0.3 + 0.1,
            vx: (Math.random() - 0.5) * 0.16,
            a: Math.random() * 0.55 + 0.15,
            t: Math.random() * Math.PI * 2,
        });
        resize();
        parts = Array.from({ length: count }, () => spawn(true));
        window.addEventListener('resize', resize);

        // Dust also drifts with scroll for a sense of depth
        let lastY = window.scrollY;
        const draw = () => {
            const dy = window.scrollY - lastY; lastY = window.scrollY;
            ctx.clearRect(0, 0, w, h);
            for (const p of parts) {
                p.y -= p.vy + dy * 0.15 * p.r; p.x += p.vx; p.t += 0.03;
                if (p.y < -10) Object.assign(p, spawn(false));
                if (p.y > h + 20) { p.y = -5; p.x = Math.random() * w; }
                const alpha = p.a * (0.6 + 0.4 * Math.sin(p.t));
                const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
                grd.addColorStop(0, `rgba(255, 228, 150, ${alpha})`);
                grd.addColorStop(1, 'rgba(255, 228, 150, 0)');
                ctx.fillStyle = grd;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2); ctx.fill();
            }
            requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
    };

    /* ---------- Curved ribbon: text flows along the hero wave ---------- */
    const initCurveRibbon = () => {
        const svg = $('#wave-svg');
        const tpl = $('#ribbon-items');
        if (!svg || !tpl) return;
        const ns = 'http://www.w3.org/2000/svg';
        const labels = Array.from(tpl.content.querySelectorAll('tspan')).map(t => t.textContent.trim());
        const H = 190;
        let textPath = null, segLen = 0, offset = 0, pathLen = 0;

        const build = () => {
            const W = svg.clientWidth || window.innerWidth;
            // Same wave as before at real pixel width; on narrow screens the curve is cropped
            // from a wider design instead of squeezed, so it stays gentle.
            const DW = Math.max(W, 1100);
            const sx = DW / 1440, ox = (W - DW) / 2;
            const P = [[0, 104], [240, 150], [480, 58], [720, 82], [960, 106], [1200, 150], [1440, 92]].map(([x, y]) => [x * sx + ox, y]);
            const ext = (a, b) => { const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy); return [a[0] + dx / l * 160, a[1] + dy / l * 160]; };
            const s0 = ext(P[0], P[1]), s1 = ext(P[6], P[5]);
            const curve = `C${P[1]} ${P[2]} ${P[3]} C${P[4]} ${P[5]} ${P[6]}`;
            const ribbonD = `M${s0} L${P[0]} ${curve} L${s1}`;
            const fillD = `M${P[0]} ${curve} L${P[6][0]},${H} L${P[0][0]},${H} Z`;

            svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.innerHTML = `
                <defs>
                    <linearGradient id="ribbon-fill" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0">
                        <stop offset="0" stop-color="#5a1512"/><stop offset=".5" stop-color="#8e2a22"/><stop offset="1" stop-color="#5a1512"/>
                    </linearGradient>
                    <linearGradient id="ribbon-edge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0">
                        <stop offset="0" stop-color="#a7801b"/><stop offset=".3" stop-color="#f0d89c"/><stop offset=".7" stop-color="#e2bd67"/><stop offset="1" stop-color="#a7801b"/>
                    </linearGradient>
                    <filter id="ribbon-glow" x="-10%" y="-60%" width="120%" height="220%">
                        <feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                </defs>
                <path class="wave-fill" d="${fillD}"/>
                <path id="ribbon-path" class="ribbon-band-edge" d="${ribbonD}" filter="url(#ribbon-glow)" opacity=".9"/>
                <path class="ribbon-band" d="${ribbonD}"/>
                <text class="ribbon-text"><textPath href="#ribbon-path" id="ribbon-textpath"></textPath></text>
                <text class="ribbon-text" id="ribbon-measure" visibility="hidden"></text>`;

            const fill = (el, times) => {
                for (let r = 0; r < times; r++) {
                    labels.forEach(label => {
                        const t = document.createElementNS(ns, 'tspan'); t.textContent = label + '\u00A0\u00A0\u00A0';
                        const sep = document.createElementNS(ns, 'tspan'); sep.setAttribute('class', 'sep'); sep.textContent = '\u2726\u00A0\u00A0\u00A0';
                        el.appendChild(t); el.appendChild(sep);
                    });
                }
            };
            const measure = $('#ribbon-measure', svg);
            fill(measure, 1);
            segLen = measure.getComputedTextLength();
            measure.remove();
            pathLen = $('#ribbon-path', svg).getTotalLength();
            textPath = $('#ribbon-textpath', svg);
            fill(textPath, Math.ceil(pathLen / Math.max(segLen, 1)) + 2);
            if (offset <= -segLen) offset = 0;
            textPath.setAttribute('startOffset', offset);
        };

        const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        ready.then(() => {
            build();
            let rw = 0;
            window.addEventListener('resize', () => { cancelAnimationFrame(rw); rw = requestAnimationFrame(build); });
            if (reduceMotion) return;
            let last = performance.now();
            let visible = true;
            new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(svg);
            const loop = (now) => {
                const dt = Math.min(now - last, 50); last = now;
                if (visible && textPath && segLen) {
                    offset -= dt * 0.06;
                    if (offset <= -segLen) offset += segLen;
                    textPath.setAttribute('startOffset', offset.toFixed(1));
                }
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        });
    };

    /* ---------- Book flip (click & hold) ---------- */
    const initBook = () => {
        const book = $('#hero-book');
        if (!book) return;
        const flip = (e) => { if (e && e.pointerType === 'mouse') e.preventDefault(); book.classList.add('is-flipped'); };
        const unflip = () => book.classList.remove('is-flipped');
        book.addEventListener('pointerdown', flip);
        window.addEventListener('pointerup', unflip);
        window.addEventListener('pointercancel', unflip);
        book.addEventListener('pointerleave', unflip);
        book.addEventListener('contextmenu', e => e.preventDefault());
        book.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
        book.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') unflip(); });
    };

    /* ---------- Card tilt + magnetic buttons ---------- */
    const initTilt = () => {
        if (!finePointer || reduceMotion) return;
        $$('.tilt, .tilt-soft').forEach(card => {
            const max = card.classList.contains('tilt-soft') ? 4 : 10;
            card.addEventListener('pointermove', e => {
                const r = card.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width;
                const py = (e.clientY - r.top) / r.height;
                card.style.transition = 'transform .2s ease-out';
                card.style.transform = `perspective(900px) rotateX(${((0.5 - py) * max).toFixed(2)}deg) rotateY(${((px - 0.5) * max).toFixed(2)}deg) translateY(-4px)`;
                card.style.setProperty('--mx', `${px * 100}%`);
                card.style.setProperty('--my', `${py * 100}%`);
            });
            card.addEventListener('pointerleave', () => {
                card.style.transition = '';
                card.style.transform = '';
            });
        });
        $$('.magnetic').forEach(btn => {
            btn.addEventListener('pointermove', e => {
                const r = btn.getBoundingClientRect();
                const x = (e.clientX - r.left - r.width / 2) * 0.18;
                const y = (e.clientY - r.top - r.height / 2) * 0.28;
                btn.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
            });
            btn.addEventListener('pointerleave', () => { btn.style.translate = ''; });
        });
    };

    /* ---------- Counter ---------- */
    const initCounters = () => {
        const els = $$('.count[data-to]');
        if (!els.length || reduceMotion) return;
        const io = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                io.unobserve(entry.target);
                const el = entry.target;
                const to = parseInt(el.dataset.to, 10);
                const start = performance.now();
                const dur = 1600;
                const step = now => {
                    const t = Math.min(1, (now - start) / dur);
                    el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3)));
                    if (t < 1) requestAnimationFrame(step);
                };
                el.textContent = '0';
                requestAnimationFrame(step);
            });
        }, { threshold: 0.6 });
        els.forEach(el => io.observe(el));
    };

    /* ---------- Modals (shared) ---------- */
    let openOverlay = null;
    const openLayer = (el) => {
        el.classList.add('is-open');
        document.body.classList.add('no-scroll');
        if (lenis) lenis.stop();
        openOverlay = el;
    };
    const closeLayer = (el) => {
        el.classList.remove('is-open');
        document.body.classList.remove('no-scroll');
        if (lenis) lenis.start();
        if (openOverlay === el) openOverlay = null;
    };

    /* ---------- Gallery carousel + lightbox ---------- */
    const initGallery = (gallery) => {
        const container = $('#image-carousel');
        if (!container) return;

        if (Array.isArray(gallery) && gallery.length) {
            container.innerHTML = '';
            gallery.forEach(g => {
                const item = document.createElement('div');
                item.className = 'carousel-item';
                item.dataset.type = g.type === 'video' ? 'video' : 'image';
                item.dataset.src = g.url;
                if (g.type === 'video') {
                    const v = document.createElement('video');
                    Object.assign(v, { src: g.url, muted: true, loop: true, playsInline: true, autoplay: true });
                    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.preload = 'metadata';
                    item.appendChild(v);
                } else {
                    const img = document.createElement('img');
                    img.src = g.url; img.alt = 'Gallery Photo'; img.loading = 'lazy';
                    img.onerror = () => { img.src = 'https://placehold.co/600x800/3b2a1d/c9a227?text=Gallery'; };
                    item.appendChild(img);
                }
                container.appendChild(item);
            });
        }

        const items = $$('.carousel-item', container);
        const total = items.length;
        if (!total) return;

        items.forEach(item => {
            if (item.dataset.type === 'video') {
                const badge = document.createElement('div');
                badge.className = 'carousel-badge';
                badge.innerHTML = '<span class="play"><i class="fa-solid fa-play"></i></span><span>Video</span>';
                item.appendChild(badge);
            } else {
                const z = document.createElement('span');
                z.className = 'carousel-zoom';
                z.innerHTML = '<i class="fa-solid fa-expand"></i>';
                item.appendChild(z);
            }
        });

        const dotsWrap = $('#car-dots');
        if (dotsWrap) {
            dotsWrap.innerHTML = '';
            items.forEach((_, i) => {
                const d = document.createElement('button');
                d.setAttribute('aria-label', `Slide ${i + 1}`);
                d.addEventListener('click', () => { go(i); restart(); });
                dotsWrap.appendChild(d);
            });
        }

        let current = 0;
        let timer = null;
        const narrow = () => window.innerWidth < 640;

        const render = () => {
            items.forEach((item, i) => {
                let offset = i - current;
                if (offset < -Math.floor(total / 2)) offset += total;
                if (offset > Math.floor(total / 2)) offset -= total;
                const abs = Math.abs(offset);
                const x = narrow() ? 62 : 68;
                item.classList.toggle('is-center', offset === 0);
                if (offset === 0) {
                    item.style.transform = 'translateX(0) translateZ(0) rotateY(0) scale(1)';
                    item.style.opacity = '1'; item.style.zIndex = '10'; item.style.filter = 'none';
                } else if (abs === 1) {
                    item.style.transform = `translateX(${offset * x}%) translateZ(-160px) rotateY(${-offset * 28}deg) scale(0.82)`;
                    item.style.opacity = '0.7'; item.style.zIndex = '5'; item.style.filter = 'brightness(0.65) saturate(0.8)';
                } else {
                    item.style.transform = `translateX(${Math.sign(offset) * x * 1.6}%) translateZ(-320px) rotateY(${-Math.sign(offset) * 40}deg) scale(0.6)`;
                    item.style.opacity = '0'; item.style.zIndex = '1'; item.style.filter = 'brightness(0.5)';
                }
            });
            if (dotsWrap) $$('button', dotsWrap).forEach((d, i) => d.classList.toggle('is-active', i === current));
        };
        const go = (i) => { current = (i + total) % total; render(); };
        const next = () => go(current + 1);
        const prev = () => go(current - 1);
        const stop = () => clearInterval(timer);
        const restart = () => { stop(); if (!reduceMotion) timer = setInterval(next, 3500); };

        render();
        restart();
        window.addEventListener('resize', render);

        const btnNext = $('#car-next');
        const btnPrev = $('#car-prev');
        if (btnNext) btnNext.onclick = () => { next(); restart(); };
        if (btnPrev) btnPrev.onclick = () => { prev(); restart(); };

        container.addEventListener('mouseenter', stop);
        container.addEventListener('mouseleave', restart);

        let sx = 0;
        container.addEventListener('touchstart', e => { sx = e.changedTouches[0].screenX; stop(); }, { passive: true });
        container.addEventListener('touchend', e => {
            const ex = e.changedTouches[0].screenX;
            if (ex < sx - 40) next();
            if (ex > sx + 40) prev();
            restart();
        }, { passive: true });

        // Lightbox
        const lightbox = $('#lightbox');
        const lbImg = $('#lb-img');
        const lbVideo = $('#lb-video');
        const closeLb = () => {
            if (!lightbox) return;
            closeLayer(lightbox);
            if (lbVideo) { lbVideo.pause(); lbVideo.removeAttribute('src'); lbVideo.hidden = true; }
            if (lbImg) lbImg.hidden = true;
            restart();
        };
        items.forEach((item, i) => {
            item.addEventListener('click', () => {
                if (i !== current) { go(i); restart(); return; }
                if (!lightbox) return;
                const src = item.dataset.src;
                if (item.dataset.type === 'video') {
                    lbImg.hidden = true;
                    lbVideo.src = src; lbVideo.hidden = false;
                    lbVideo.play().catch(() => { });
                } else {
                    if (lbVideo) { lbVideo.pause(); lbVideo.hidden = true; }
                    lbImg.src = src; lbImg.hidden = false;
                }
                stop();
                openLayer(lightbox);
            });
        });
        if (lightbox) {
            $('#lb-close').addEventListener('click', closeLb);
            lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLb(); });
            lightbox._close = closeLb;
        }
    };

    /* ---------- FAQ ---------- */
    const bindFaq = () => {
        const items = $$('.faq-item');
        items.forEach(item => {
            const btn = $('.faq-q', item);
            btn.addEventListener('click', () => {
                const isOpen = item.classList.contains('is-open');
                items.forEach(o => { o.classList.remove('is-open'); $('.faq-q', o).setAttribute('aria-expanded', 'false'); });
                if (!isOpen) { item.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true'); }
            });
        });
    };
    const renderFaq = (faqs) => {
        const wrap = $('#faq-accordion');
        if (!wrap || !Array.isArray(faqs) || !faqs.length) return;
        wrap.innerHTML = '';
        faqs.forEach((f, i) => {
            const item = document.createElement('div');
            item.className = 'faq-item reveal is-visible';
            item.innerHTML = `<button class="faq-q" aria-expanded="false"><span class="num">${String(i + 1).padStart(2, '0')}</span><span class="txt"></span><span class="faq-icon"></span></button><div class="faq-a"><div><p></p></div></div>`;
            $('.txt', item).textContent = f.question;
            $('.faq-a p', item).textContent = f.answer;
            wrap.appendChild(item);
        });
    };

    /* ---------- Price / settings ---------- */
    let BOOK_PRICE = parseInt(store.get('cachedBookPrice') || '', 10) || DEFAULT_PRICE;
    const qtyInput = $('#wa-qty');
    const totalEl = $('#wa-total-amount');
    const getQty = () => Math.max(1, parseInt(qtyInput?.value, 10) || 1);
    const paintPrice = () => {
        $$('.js-price').forEach(el => { el.textContent = `₹${BOOK_PRICE}`; });
        if (totalEl) totalEl.textContent = `₹${getQty() * BOOK_PRICE}`;
    };

    const applySettings = (settings) => {
        if (!settings) return;
        if (settings.isOrderNowEnabled === true) {
            $$('.order-now-btn').forEach(b => b.classList.remove('order-now-btn'));
            const notice = $('#website-order-notice');
            if (notice) notice.style.display = 'none';
        }
        if (settings.bookPrice !== undefined) {
            BOOK_PRICE = parseInt(settings.bookPrice, 10) || DEFAULT_PRICE;
            store.set('cachedBookPrice', String(BOOK_PRICE));
            paintPrice();
        }
    };

    /* ---------- Order Now (auth redirect, unchanged behaviour) ---------- */
    const getAuth = () => {
        try { return JSON.parse(sessionStorage.getItem('bookAuth') || localStorage.getItem('bookAuth') || 'null'); }
        catch (e) { return null; }
    };
    const initAuthUI = () => {
        const auth = getAuth();
        const loginLink = $('#login-nav-link');
        const mobileLoginLink = $('#mobile-login-link');
        const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const firstName = auth && auth.name ? auth.name.trim().split(' ')[0] : null;

        if (loginLink) {
            loginLink.innerHTML = `<i class="fa-solid fa-circle-user"></i><span>${auth ? esc(firstName || 'Account') : 'Login / Signup'}</span>`;
            loginLink.href = auth ? 'account.html' : 'login.html';
        }
        if (mobileLoginLink) {
            mobileLoginLink.innerHTML = `<span>${auth ? 'Hello, ' + esc(auth.name || 'User') : 'Login / Signup'}</span> <i class="fa-solid fa-circle-user"></i>`;
            mobileLoginLink.href = auth ? 'account.html' : 'login.html';
        }

        // Unseen-voucher dot on the account link
        const token = store.get('bookAuthToken');
        if (auth && loginLink && token) {
            fetch(`${API_BASE}/api/vouchers/my-vouchers`, { headers: { Authorization: `Bearer ${token}` } })
                .then(r => r.json())
                .then(d => {
                    let viewed = false;
                    try { viewed = sessionStorage.getItem('viewedVouchers') === 'true'; } catch (e) { /* ignore */ }
                    if (d.success && d.vouchers && d.vouchers.length > 0 && !viewed) {
                        loginLink.insertAdjacentHTML('beforeend', '<span class="voucher-dot" aria-label="New voucher"></span>');
                    }
                })
                .catch(() => { });
        }
    };

    const initAuthLinks = () => {
        $$('.auth-required').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const redirect = link.getAttribute('data-redirect') || 'index.html#footer-contact';
                location.href = getAuth() ? redirect : `login.html?redirect=${encodeURIComponent(redirect)}`;
            });
        });
    };

    /* ---------- WhatsApp order modal ---------- */
    const initWhatsApp = () => {
        const modal = $('#wa-order-modal');
        const form = $('#wa-order-form');
        if (!modal || !form) {
            // Pages without the modal open WhatsApp chat directly
            $$('.js-open-wa').forEach(b => b.addEventListener('click', () => window.open(`https://wa.me/${WA_NUMBER}`, '_blank')));
            return;
        }
        const close = () => closeLayer(modal);
        $$('.js-open-wa').forEach(b => b.addEventListener('click', e => {
            e.preventDefault();
            openLayer(modal);
            setTimeout(() => $('#wa-name')?.focus({ preventScroll: true }), 350);
        }));
        $('#close-wa-modal').addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal._close = close;

        $$('[data-qty]', modal).forEach(b => b.addEventListener('click', () => {
            qtyInput.value = Math.max(1, getQty() + parseInt(b.dataset.qty, 10));
            paintPrice();
        }));
        qtyInput.addEventListener('input', paintPrice);

        form.addEventListener('submit', e => {
            e.preventDefault();
            const name = $('#wa-name').value;
            const mobile = $('#wa-mobile').value;
            const address = $('#wa-address').value;
            const qty = getQty();
            const total = qty * (BOOK_PRICE || DEFAULT_PRICE);
            const message = `Hello Jagirdar Publications, I would like to Pre-Order the book 'ब्रह्मांशावतार श्री खेतेश्वर दाता'.\n\nName: ${name}\nMobile: ${mobile}\nAddress: ${address}\nQuantity: ${qty}\nTotal Amount: ₹${total}`;
            window.open(`https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(message)}`, '_blank');
            close();
        });

        // Floating button appears after the hero
        const fab = $('.wa-float');
        const hero = $('#hero');
        if (fab && hero) {
            new IntersectionObserver(([e]) => fab.classList.toggle('is-visible', !e.isIntersecting), { threshold: 0.05 }).observe(hero);
        } else if (fab) fab.classList.add('is-visible');
    };

    /* ---------- Policy page side-nav highlight ---------- */
    const initPolicyNav = () => {
        const page = document.body.dataset.page;
        $$('.policy-nav a').forEach(a => a.classList.toggle('is-active', a.dataset.page === page));
    };

    /* ---------- Escape key ---------- */
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (openOverlay && openOverlay._close) openOverlay._close();
            closeMenu();
        }
        if (openOverlay === null && document.activeElement?.closest?.('#image-carousel')) {
            if (e.key === 'ArrowRight') $('#car-next')?.click();
            if (e.key === 'ArrowLeft') $('#car-prev')?.click();
        }
    });

    /* ---------- Boot ---------- */
    const boot = () => {
        initLenis();
        initAnchors();
        initHeader();
        initCurveRibbon();
        initReveal();
        initMandala();
        initParticles();
        initParallax();
        initBook();
        initTilt();
        initCounters();
        initAuthUI();
        initAuthLinks();
        initWhatsApp();
        initPolicyNav();
        paintPrice();

        if ($('#faq-accordion')) {
            fetch(`${API_BASE}/api/public/faq`).then(r => r.json())
                .then(d => { if (d.success) renderFaq(d.faqs); })
                .catch(() => { })
                .finally(bindFaq);
        }
        if ($('#image-carousel')) {
            fetch(`${API_BASE}/api/public/gallery`).then(r => r.json())
                .then(d => initGallery(d.success ? d.gallery : null))
                .catch(() => initGallery(null));
        }
        fetch(`${API_BASE}/api/settings/frontend`).then(r => r.json())
            .then(d => { if (d.success) applySettings(d.settings); })
            .catch(err => console.error('Error fetching frontend settings:', err));
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // Disable right click & developer tool shortcuts (kept from original site)
    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('keydown', e => {
        if (e.keyCode === 123 || (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) || (e.ctrlKey && e.keyCode === 85)) {
            e.preventDefault();
        }
    });
})();
