# تقرير تثبيت مهارات تحرير الفيديو (2026-11-01)

البيئة: جلسة Claude Code سحابية على Linux x86_64. المتوفر: FFmpeg 6.1.1 وNode 22 وPython 3.13 وuv وbun وChromium.
لإعادة التثبيت في أي جلسة جديدة شغّل: `bash scripts/video-skills/install.sh`

| # | المهارة | الحالة | ملاحظات |
|---|---------|--------|---------|
| 1 | Embedded Captions | ⚠️ أُلغيت من المصدر | أوقفت HeyGen هذه المهارة في 2026-10-21 (commit `68822931`) ونقلت محتواها إلى مهارة `hyperframes` في الملف `references/captions.md`. ثُبّتت `hyperframes` بدلاً منها. |
| 2 | Talking Head Recut | ⚠️ أُلغيت من المصدر | دُمجت بنفس الطريقة في `hyperframes` (ملفا `references/overlays.md` و`captions.md`). |
| — | HyperFrames (hyperframes, hyperframes-cli, hyperframes-registry, media-use) | ✅ مثبتة وتظهر للوكيل | **لم تُختبر بالتشغيل** (انظر "المتطلبات الناقصة"). |
| 3 | Herk Edit Kit | ✅ نُسخت كمساحة عمل في `~/video-kits/herk-edit-kit` | ليست مهارة مستقلة؛ فيها 15 مهارة تستدعي سكربتات داخل المستودع نفسه، وتعتمد على HyperFrames 0.7.109 الأقدم. تُستخدم بفتح Claude داخل مجلدها. لم تُختبر. |
| 4 | FFmpeg Skill | ✅ مثبتة وتظهر للوكيل | فحصتُ يدوياً كل فلاتر FFmpeg والمُرمِّزات المطلوبة والاختيارية، وكلها موجودة (ومنها libvidstab وlibass وzscale). لم يُشغَّل `doctor`. |
| 5 | Video Toolkit | ✅ نُسخت المهارة + المستودع إلى `~/video-kits/claude-code-video-toolkit` | لم تُختبر. |

## المتطلبات الناقصة
1. **إذن تشغيل الكود الخارجي:** رفض نظام الأمان التلقائي في الجلسة أوامر `npx ffmpeg-skill` و`npx hyperframes skills update` وسكربت `doctor.py`، لأنها تشغّل كوداً منزّلاً من الإنترنت. لهذا ثُبّتت المهارات بنسخ الملفات فقط ولم تُشغّل أي اختبارات. أوامر الاختبار مكتوبة في آخر `install.sh`.
2. **الشبكة:** سياسة الشبكة في البيئة تحجب `skills.sh` و`api.elevenlabs.io` و`huggingface.co`. أما `registry.npmjs.org` و`pypi.org` وGitHub فمسموحة.
3. **التفريغ الصوتي (تحويل الكلام إلى نص):** لا يوجد محرك تفريغ محلي. `pip install faster-whisper` يثبّته، لكن تنزيل النموذج يحتاج `huggingface.co` المحجوب.
4. **خدمات مدفوعة (لم تُستخدم):**
   - ElevenLabs (للتفريغ في Herk Kit، وللصوت في Toolkit)
   - Kie.ai
   - توليد الصور والفيديو عبر HeyGen
   - Modal أو RunPod للمعالجة السحابية بالـ GPU في Toolkit

   كل هذه تحتاج مفاتيح API وموافقتك قبل استخدامها.
5. **البيئة مؤقتة:** النسخ في `~/.claude/skills` و`~/video-kits` تُحذف عند إغلاق الحاوية. لذلك حُفظ سكربت التثبيت في المستودع.
