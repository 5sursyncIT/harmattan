const fs = require('fs');
const filePath = '/var/www/html/senharmattan-shop/src/components/home/HeroCarousel.jsx';
let content = fs.readFileSync(filePath, 'utf8');

// Update names
content = content.replace(/'\/images\/slider\/prix-ken-bugul.jpg'/g, "'/images/slider/banniére site ecommerce HS2_tissou copie.jpg'");
content = content.replace(/'\/images\/slider\/prix-lyceennes.jpg'/g, "'/images/slider/banniére site ecommerce HS2_Helene copie.jpg'");

fs.writeFileSync(filePath, content);
