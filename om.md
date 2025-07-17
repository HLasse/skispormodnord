---
layout: page
title: Om os
---

<style>
.two-column-layout {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 2rem;
  align-items: start;
  margin-top: 2rem;
}

.person-section {
  display: contents;
}

.text-section {
  margin-bottom: 2rem;
}

.text-section h3 {
  margin-top: 0;
}

.image-section {
  margin-bottom: 2rem;
}

.image-section img {
  width: 100%;
  height: auto;
  object-fit: cover;
  border-radius: 8px;
}

@media (max-width: 768px) {
  .two-column-layout {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  
  .person-section {
    display: block;
  }
  
  .image-section {
    margin-top: 1rem;
  }
}
</style>

Hej! 👋 

Vi hedder Solvej og Lasse, og vi elsker at være på tur! Vi bor til dagligt i Aarhus, og flygter til fjeldene hver gang vi får chancen 🏔️

<div class="two-column-layout">
  <div class="person-section">
    <div class="text-section">
      <h3>Solvej</h3>
      <p>Lasse fik for alvor interesse for friluftsliv efter et højskoleophold på Nørgaards Højskole i 2015. Det har udmøntet sig i en masse vandring rundt omkring i verden, klatring, og nu også ski! Lasse havde sammenlagt to ugers erfaring på fjeldski før turen, så hvis han kan, kan du også!</p>

      <p>Lasse fik for alvor interesse for friluftsliv efter et højskoleophold på Nørgaards Højskole i 2015. Det har udmøntet sig i en masse vandring rundt omkring i verden, klatring, og nu også ski! Lasse havde sammenlagt to ugers erfaring på fjeldski før turen, så hvis han kan, kan du også!</p>
    </div>
    
    <div class="image-section">
      <img src="/assets/img/solvej.jpeg" alt="Solvej">
    </div>
  </div>
  
  <div class="person-section">
    <div class="text-section">
      <h3>Lasse</h3>
      <p>Lasse fik for alvor interesse for friluftsliv efter et højskoleophold på Nørgaards Højskole i 2015. Det har udmøntet sig i en masse vandring rundt omkring i verden, klatring, og nu også ski! Lasse havde sammenlagt to ugers erfaring på fjeldski før turen, så hvis han kan, kan du også!</p>
      
      <p>Lasse har en kandidat cognitive science og en PhD i kunstig intelligens i sundhedsvæsenet. Han elsker machine learning, store sprogmodeller, og lange ture i naturen.</p>
    </div>
    
    <div class="image-section">
      <img src="/assets/img/lasse.jpeg" alt="Lasse">
    </div>
  </div>
</div>