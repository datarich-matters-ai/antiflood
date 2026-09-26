# antiflood: เช็คระดับน้ำ & ขอความช่วยเหลือ

เว็บแอปมือถือ (PWA) สำหรับช่วงน้ำท่วม ใช้ได้ทุกจังหวัด เปิดจากลิงก์ได้ทันทีโดยไม่ต้องรอ App Store และกด "เพิ่มไปยังหน้าจอหลัก" ให้ใช้งานเหมือนแอปได้

## ฟีเจอร์
- **ใกล้ฉัน**: ใช้ GPS หาสถานีวัดระดับน้ำที่ใกล้ที่สุด แสดงสถานะ (ล้นตลิ่ง / น้ำมาก / ปกติ / น้ำน้อย) พร้อมคำแนะนำว่าควรทำอะไร หรือเลือกดูทั้งจังหวัด
- **แผนที่**: แสดงทุกสถานีทั่วประเทศแยกสีตามสถานะ
- **ขอความช่วยเหลือ**: กรอกจำนวนคน กลุ่มเปราะบาง และสิ่งที่ต้องการ แอปแนบพิกัด GPS แล้วแชร์ผ่าน LINE, SMS หรือคัดลอกไปโพสต์ได้
- เบอร์ฉุกเฉินกดโทรได้ทันที, เช็กลิสต์เตรียมรับน้ำ, ลิงก์แหล่งข้อมูลทางการ
- ใช้งานออฟไลน์ได้ โดยแสดงข้อมูลล่าสุดที่เคยโหลดไว้

ข้อมูลระดับน้ำมาจาก [ThaiWater (สสน.)](https://www.thaiwater.net/water/wl) GitHub Actions ดึงข้อมูลใหม่ทุก ~20 นาที
แอปนี้ไม่ใช่ช่องทางแจ้งเตือนทางการ ให้ติดตามประกาศจาก ปภ. และอำเภอเป็นหลัก

## Deploy (GitHub Pages)
1. Merge เข้า `main` (scheduled workflow ทำงานเฉพาะบน default branch)
2. Settings → Pages → Source: **GitHub Actions**
3. Actions → `update-and-deploy` → Run workflow
4. แชร์ลิงก์ `https://<org>.github.io/antiflood/`

GitHub Pages สำหรับ private repo ต้องใช้แพ็กเกจที่เสียเงิน ถ้า repo เป็น private และไม่อยากเปิดเป็น public ให้ deploy โฟลเดอร์ `public/` ไป Netlify หรือ Cloudflare Pages แทน แล้วรัน `node scripts/fetch-waterlevel.mjs` ตามรอบเวลา

## ปรับแต่งรายจังหวัด
แก้ `public/config.js`:
- `provinceHotlines`: เบอร์ศูนย์ ปภ. จังหวัด, ศูนย์พักพิง, อาสากู้ภัยในพื้นที่ (ใช้ชื่อจังหวัดตามที่ ThaiWater สะกด)
- `hotlines`, `links`: เบอร์และลิงก์ส่วนกลาง

## รันบนเครื่อง
```sh
node scripts/fetch-waterlevel.mjs      # สร้าง public/data/waterlevel.json
cd public && python3 -m http.server 8000
```

## โครงสร้าง
- `public/`: ตัวแอป (HTML/CSS/JS ล้วน ไม่มี build step), Leaflet อยู่ใน `public/vendor/`
- `scripts/fetch-waterlevel.mjs`: ดึงข้อมูลจาก ThaiWater แล้วย่อเหลือเฉพาะฟิลด์ที่ใช้
- `.github/workflows/deploy.yml`: ดึงข้อมูลตามรอบเวลาและ deploy
