کیوباز در یک کانتینر
====================

یک کانتینر همهٔ فرایندها را اجرا می‌کند: هسته، سایت، ربات تلگرام و (اختیاری) پروکسی تلگرام.
پورت سایت: 8000 (یا مقدار PORT که پلتفرم می‌دهد). دیسک پایدار باید روی /data وصل شود.

۱) ساخت
   docker build -t qbazz .
   (یا پوشهٔ qbazz-image را به ساخت خود پلتفرم بدهید)

۲) دیسک پایدار
   یک volume با حجم دست‌کم ۲۵ گیگ را روی مسیر /data وصل کنید.
   بدون آن، با هر دیپلوی دیتابیس و عکس‌ها پاک می‌شود.

۳) متغیرهای محیطی (در پنل پلتفرم)
   لازم:
     QBAZZ_WEB_URL=https://آدرس-عمومی-سایت        (بدون / آخر)
   اگر ربات تلگرام می‌خواهید:
     TELEGRAM_BOT_TOKEN=...
     TELEGRAM_BOT_USERNAME=نام_ربات                 (بدون @)
     QBAZZ_PROXY_SUBSCRIPTION=لینک-اشتراک-VPN      (اگر پلتفرم به تلگرام دسترسی ندارد)
   سایر تنظیمات (همان‌هایی که در .env سرور فعلی است):
     QBAZZ_LOCALE=fa   QBAZZ_CURRENCY=IRT   QBAZZ_STORE_APPROVAL=true   QBAZZ_PAY_PROVIDER=sandbox
     کلید پیامک، FASHN_API_KEY، GEMINI_API_KEY، QBAZZ_AI_PROVIDER و ...
   QBAZZ_SECRET و کلید سرویس ربات را اگر ندهید، خودکار ساخته و در /data نگه داشته می‌شوند.

۴) انتقال داده‌های سرور فعلی
   روی سرور فعلی:   cd /root/qbazz-demo && systemctl stop qbazz-core && tar -czf data.tar.gz data
   فایل را به محیط جدید ببرید و بازش کنید طوری که این دو مسیر ساخته شوند:
     /data/qbazz.json        و        /data/uploads/
   (محتوای پوشهٔ data را مستقیم در /data بریزید، نه پوشهٔ data داخل /data)

فقط یک نمونه (replica) اجرا کنید: دیتابیس یک فایل است.
