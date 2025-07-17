---
layout: page
title: Kontakt
---


<style>
.offers-container {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  margin-top: 2rem;
}

.services {
  flex: 2;
  min-width: 300px;
}

.contact-form {
  flex: 1;
  min-width: 300px;
  background: #f9f9f9;
  padding: 1.5rem;
  border-radius: 8px;
  box-shadow: 0 0 10px rgba(0,0,0,0.05);
}

.service-card {
  background: #ffffff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  box-shadow: 0 2px 6px rgba(0,0,0,0.05);
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}

.service-emoji {
  font-size: 1.8rem;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 2px;
}

.service-text {
  flex: 1;
}

.service-text h3 {
  margin: 0 0 0.5rem;
}

.service-text p {
  margin: 0;
}

form input, form textarea {
  width: 100%;
  margin-bottom: 1rem;
  padding: 0.75rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}

form button {
  background-color: #007acc;
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  cursor: pointer;
}

form button:hover {
  background-color: #005fa3;
}
</style>


Vi vil elske at flere kommer ud på tur, så vi håber at siden her har givet lidt inspiration eller hjælp!

For at sprede turglæden til endnu flere, tilbyder vi forskellige tjenester. Vi vender tilbage så hurtigt vi kan! 


<div class="offers-container">

  <!-- Services Column -->
  <div class="services">

    <div class="service-card">
      <div class="service-emoji">🎤</div>
      <div class="service-text">
        <h3>Foredrag og oplæg</h3>
        <p>Tilpasset fx højskoler eller efterskoler.</p>
      </div>
    </div>

    <div class="service-card">
      <div class="service-emoji">🗺️</div>
      <div class="service-text">
        <h3>Hjælp til turplanlægning</h3>
        <p>Vi hjælper med rutevalg, mad- og udstyrsplanlægning – uanset om du skal på dagstur eller længere ekspedition.</p>
      </div>
    </div>

    <div class="service-card">
      <div class="service-emoji">🏔️</div>
      <div class="service-text">
        <h3>Privat guide</h3>
        <p>Slap af, og lad os stå for det praktiske! Solvej er uddannet og erfaren guide på både sommer- og vinterture, og tager gerne dig/jer på eventyr!</p>
      </div>
    </div>

  </div>

  <!-- Contact Form Column -->
  <div class="contact-form">
    <h2>Kontakt os</h2>
    <form method="POST" action="https://public.herotofu.com/v1/303b9f30-6243-11f0-b5c2-1b1b69dd9a22">
      <input type="text" name="name" placeholder="Dit navn" required>
      <input type="email" name="_replyto" placeholder="Din email" required>
      <textarea name="message" rows="5" placeholder="Din besked" required></textarea>
      <button type="submit">Send besked</button>
    </form>
  </div>

</div>






